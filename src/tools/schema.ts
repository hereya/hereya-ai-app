import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { sql, isValidIdentifier, quoteIdent } from "../db.js";
import { describeSchemaStructure } from "../schema-utils.js";
import { createFolder, deleteFolderRecursive } from "../storage.js";
import { toolError } from "../errors.js";
import { deleteSkillsForSchema } from "./skills.js";
import { deleteAppBackend } from "../app-lambda.js";
import { deleteAppAuth } from "../app-auth.js";
import { setCustomDomains, checkCustomDomains } from "../custom-domain.js";

export function registerSchemaTools(server: McpServer) {
  // --- create-schema ---
  server.registerTool(
    "create-schema",
    {
      title: "Create Schema",
      description:
        "Create a new app schema in the database. Each schema represents an app (e.g., recipes, billing, contacts). Also creates a corresponding file storage folder.",
      inputSchema: {
        name: z
          .string()
          .describe(
            "Schema name. Lowercase letters and digits only — no hyphens or underscores, must start with a letter, max 63 chars. Example: 'orders', 'recipes2', 'contactmanager'."
          ),
      },
    },
    async ({ name }) => {
      // Stricter than isValidIdentifier(): disallow `_` and `-` so the schema
      // name is simultaneously a valid Postgres identifier AND a valid DNS
      // label. This keeps the app URL (`{schema}.{customDomain}`) and the
      // per-app Postmark sender domain identical and standards-compliant.
      // Existing schemas predating this rule (e.g. `terroir_direct`,
      // `hereya_landing`) continue to work; only new schemas are constrained.
      if (!/^[a-z][a-z0-9]{0,62}$/.test(name)) {
        return toolError(
          "INVALID_NAME",
          `Invalid schema name: "${name}". Must be lowercase letters and digits only, start with a letter, max 63 chars. No hyphens or underscores.`
        );
      }

      await sql(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(name)}`);

      // Create corresponding S3 folder
      try {
        await createFolder(name);
      } catch {
        // S3 folder creation is best-effort
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ schema: name, created: true }),
          },
        ],
      };
    }
  );

  // --- list-schemas ---
  server.registerTool(
    "list-schemas",
    {
      title: "List Schemas",
      description: "List all app schemas in the database.",
      inputSchema: {},
    },
    async () => {
      const result = await sql(
        `SELECT schema_name FROM information_schema.schemata
         WHERE schema_name NOT IN ('public', 'information_schema', 'pg_catalog', 'pg_toast', '_hereya')
         AND schema_name NOT LIKE 'pg_%'
         ORDER BY schema_name`
      );

      const schemas = (result.records ?? []).map(
        (row) => row[0].stringValue!
      );

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ schemas }),
          },
        ],
      };
    }
  );

  // --- describe-schema ---
  server.registerTool(
    "describe-schema",
    {
      title: "Describe Schema",
      description:
        "Get the full structure of a schema: all tables with columns, types, and constraints.",
      inputSchema: {
        schema: z.string().describe("Schema name"),
      },
    },
    async ({ schema }) => {
      const structure = await describeSchemaStructure(schema);
      if (!structure) {
        return toolError("SCHEMA_NOT_FOUND", `Schema '${schema}' does not exist in this database`);
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(structure, null, 2),
          },
        ],
      };
    }
  );

  // --- drop-schema ---
  server.registerTool(
    "drop-schema",
    {
      title: "Drop Schema",
      description:
        "Drop a schema and all its tables, data, files, and skills. DESTRUCTIVE. Requires confirm=true.",
      inputSchema: {
        schema: z.string().describe("Schema name"),
        confirm: z.boolean().describe("Must be true to proceed. Safety check."),
      },
    },
    async ({ schema, confirm }) => {
      if (!confirm) {
        return toolError("CONFIRMATION_REQUIRED", "confirm must be true to drop a schema");
      }

      // Check schema exists
      const schemaCheck = await sql(
        `SELECT 1 FROM information_schema.schemata WHERE schema_name = :name`,
        [{ name: "name", value: { stringValue: schema } }]
      );
      if (!schemaCheck.records?.length) {
        return toolError("SCHEMA_NOT_FOUND", `Schema '${schema}' does not exist in this database`);
      }

      // Get list of tables before dropping
      const tablesResult = await sql(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = :schema AND table_type = 'BASE TABLE'
         ORDER BY table_name`,
        [{ name: "schema", value: { stringValue: schema } }]
      );
      const droppedTables = (tablesResult.records ?? []).map(
        (row) => row[0].stringValue!
      );

      // Drop schema
      await sql(`DROP SCHEMA ${quoteIdent(schema)} CASCADE`);

      // Delete S3 folder
      try {
        await deleteFolderRecursive(schema);
      } catch {
        // Best-effort cleanup
      }

      // Delete all skills for this schema
      try {
        await deleteSkillsForSchema(schema);
      } catch {
        // Best-effort cleanup
      }

      // Delete per-app backend Lambda + API Gateway routes
      try {
        await deleteAppBackend(schema);
      } catch {
        // Best-effort cleanup
      }

      // Delete per-app auth resources (Cognito pool, Postmark server, DNS, SSM)
      try {
        await deleteAppAuth(schema);
      } catch {
        // Best-effort cleanup
      }

      // Delete shared-table rows keyed by schema name (frontend config, per-
      // user access grants). These live in public schemas outside the app
      // schema so DROP SCHEMA CASCADE does not touch them.
      try {
        await sql(
          `DELETE FROM public._config WHERE schema_name = :schema`,
          [{ name: "schema", value: { stringValue: schema } }]
        );
      } catch {
        // table may not exist yet
      }
      try {
        await sql(
          `DELETE FROM public._user_access WHERE schema_name = :schema`,
          [{ name: "schema", value: { stringValue: schema } }]
        );
      } catch {
        // table may not exist yet
      }

      // Remove any custom domains bound to this schema (re-issues cert without
      // them, swaps the distribution, deletes old cert). Both steps are needed:
      // setCustomDomains([]) marks removals, checkCustomDomains promotes them.
      try {
        await setCustomDomains(schema, []);
        await checkCustomDomains(schema);
      } catch {
        // Best-effort cleanup — if the cert hasn't issued yet or CloudFront is
        // mid-deploy, the pending rows will be reconciled on the next call.
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              schema,
              dropped: true,
              tables_dropped: droppedTables,
            }),
          },
        ],
      };
    }
  );
}
