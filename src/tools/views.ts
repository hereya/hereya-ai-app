import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { sql, sqlWithMetadata, convertParams, extractFieldValue, quoteIdent } from "../db.js";
import { toolError } from "../errors.js";
import { VIEW_SHELL_HTML } from "../shell/generated.js";
import Mustache from "mustache";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RESOURCE_URI = "ui://hereya/view";
const RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";

// ---------------------------------------------------------------------------
// Per-schema _views table — lazy initialization
// ---------------------------------------------------------------------------

const VIEW_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,253}$/i;

const viewTablesReady = new Set<string>();

async function ensureViewsTable(schema: string) {
  if (viewTablesReady.has(schema)) return;
  await sql(`
    CREATE TABLE IF NOT EXISTS ${quoteIdent(schema)}._views (
      name VARCHAR(255) PRIMARY KEY,
      description TEXT,
      template TEXT NOT NULL,
      queries JSONB NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  viewTablesReady.add(schema);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function schemaExists(schema: string): Promise<boolean> {
  const result = await sql(
    `SELECT 1 FROM information_schema.schemata WHERE schema_name = :name`,
    [{ name: "name", value: { stringValue: schema } }]
  );
  return !!(result.records?.length);
}

async function viewsTableExists(schema: string): Promise<boolean> {
  const result = await sql(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = :schema AND table_name = '_views'`,
    [{ name: "schema", value: { stringValue: schema } }]
  );
  return !!(result.records?.length);
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerViewTools(server: McpServer) {
  // --- UI resource — static shell that receives rendered HTML via tool result ---
  server.registerResource(
    "Hereya View",
    RESOURCE_URI,
    { mimeType: RESOURCE_MIME_TYPE },
    async (): Promise<ReadResourceResult> => ({
      contents: [
        {
          uri: RESOURCE_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: VIEW_SHELL_HTML,
        },
      ],
    })
  );

  // --- save-view ---
  server.registerTool(
    "save-view",
    {
      title: "Save View",
      description:
        "Save or update a reusable HTML view with data queries. Templates use web components + Mustache. No frameworks, no CDN imports.",
      inputSchema: {
        schema: z.string().describe("Schema this view belongs to"),
        name: z.string().describe("View name (lowercase, alphanumeric, underscores, hyphens)"),
        template: z
          .string()
          .describe("HTML with {{}} placeholders, web components, inline JS. No frameworks, no CDN imports."),
        queries: z
          .record(z.string())
          .describe("Named SQL queries. Keys become template variables."),
        description: z
          .string()
          .optional()
          .describe("What this view shows"),
      },
    },
    async ({ schema, name, template, queries, description }) => {
      if (!VIEW_NAME_RE.test(name)) {
        return toolError(
          "INVALID_NAME",
          `Invalid view name: "${name}". Must be lowercase alphanumeric with underscores/hyphens, max 254 chars.`
        );
      }

      if (!(await schemaExists(schema))) {
        return toolError(
          "SCHEMA_NOT_FOUND",
          `Schema '${schema}' does not exist. Create it first with create-schema.`
        );
      }

      await ensureViewsTable(schema);

      const queriesJson = JSON.stringify(queries);

      await sql(
        `INSERT INTO ${quoteIdent(schema)}._views (name, description, template, queries)
         VALUES (:name, :desc, :template, :queries::jsonb)
         ON CONFLICT (name)
         DO UPDATE SET template = :template, queries = :queries::jsonb, description = :desc, updated_at = NOW()`,
        [
          { name: "name", value: { stringValue: name } },
          { name: "desc", value: description ? { stringValue: description } : { isNull: true } },
          { name: "template", value: { stringValue: template } },
          { name: "queries", value: { stringValue: queriesJson } },
        ]
      );

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ schema, view: name, saved: true }),
          },
        ],
      };
    }
  );

  // --- get-view ---
  server.registerTool(
    "get-view",
    {
      title: "Get View",
      description:
        "Render a saved view with fresh data (~100ms). Returns rendered HTML via the UI resource shell. Check list-views first.",
      inputSchema: {
        schema: z.string().describe("Schema the view belongs to"),
        name: z.string().describe("View name"),
        params: z
          .record(z.unknown())
          .optional()
          .describe("Runtime params for queries"),
      },
      _meta: {
        ui: { resourceUri: RESOURCE_URI },
        "ui/resourceUri": RESOURCE_URI,
      },
    },
    async ({ schema, name, params }) => {
      // Check if _views table exists
      if (!(await viewsTableExists(schema))) {
        return toolError(
          "VIEW_NOT_FOUND",
          `View '${name}' not found for schema '${schema}'`
        );
      }

      // Load view
      const viewResult = await sql(
        `SELECT template, queries FROM ${quoteIdent(schema)}._views WHERE name = :name`,
        [{ name: "name", value: { stringValue: name } }]
      );

      if (!viewResult.records?.length) {
        return toolError(
          "VIEW_NOT_FOUND",
          `View '${name}' not found for schema '${schema}'`
        );
      }

      const row = viewResult.records[0];
      const template = row[0].stringValue!;
      const queries: Record<string, string> = JSON.parse(row[1].stringValue!);

      // Execute queries and build template context
      const context: Record<string, unknown> = {};
      const parameters = params ? convertParams(params) : undefined;

      try {
        for (const [key, queryStr] of Object.entries(queries)) {
          const result = await sqlWithMetadata(queryStr, parameters);
          const columns =
            result.columnMetadata?.map((c) => c.name ?? "?") ?? [];
          const rows = (result.records ?? []).map((record) => {
            const obj: Record<string, unknown> = {};
            columns.forEach((col, i) => {
              obj[col] = extractFieldValue(record[i]);
            });
            return obj;
          });

          context[key] = rows.length === 0 ? null : rows;
        }
      } catch (err: any) {
        return toolError("SQL_ERROR", err.message ?? String(err));
      }

      // Render template
      let renderedHtml: string;
      try {
        renderedHtml = Mustache.render(template, context);
      } catch (err: any) {
        return toolError("RENDER_ERROR", err.message ?? String(err));
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              view: name,
              schema,
              rendered: true,
              queries_executed: Object.keys(queries).length,
            }),
          },
        ],
        structuredContent: { html: renderedHtml },
      };
    }
  );

  // --- list-views ---
  server.registerTool(
    "list-views",
    {
      title: "List Views",
      description:
        "List saved views for a schema. Check before regenerating widgets.",
      inputSchema: {
        schema: z.string().describe("Schema to list views for"),
      },
    },
    async ({ schema }) => {
      if (!(await schemaExists(schema))) {
        return toolError(
          "SCHEMA_NOT_FOUND",
          `Schema '${schema}' does not exist`
        );
      }

      // If _views table doesn't exist yet, return empty
      if (!(await viewsTableExists(schema))) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ schema, views: [] }),
            },
          ],
        };
      }

      const result = await sql(
        `SELECT name, description,
                (SELECT count(*) FROM jsonb_object_keys(queries)) as queries_count
         FROM ${quoteIdent(schema)}._views
         ORDER BY name`
      );

      const views = (result.records ?? []).map((row) => ({
        name: row[0].stringValue,
        description: row[1].isNull ? null : row[1].stringValue,
        queries_count: row[2].longValue ?? 0,
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ schema, views }),
          },
        ],
      };
    }
  );

  // --- delete-view ---
  server.registerTool(
    "delete-view",
    {
      title: "Delete View",
      description: "Delete a saved view.",
      inputSchema: {
        schema: z.string().describe("Schema"),
        name: z.string().describe("View name"),
      },
    },
    async ({ schema, name }) => {
      // If _views table doesn't exist, the view can't exist
      if (!(await viewsTableExists(schema))) {
        return toolError(
          "VIEW_NOT_FOUND",
          `View '${name}' not found for schema '${schema}'`
        );
      }

      const result = await sql(
        `DELETE FROM ${quoteIdent(schema)}._views WHERE name = :name`,
        [{ name: "name", value: { stringValue: name } }]
      );

      if ((result.numberOfRecordsUpdated ?? 0) === 0) {
        return toolError(
          "VIEW_NOT_FOUND",
          `View '${name}' not found for schema '${schema}'`
        );
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ deleted: name }),
          },
        ],
      };
    }
  );
}
