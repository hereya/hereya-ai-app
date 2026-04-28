import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { sql, isValidIdentifier } from "../db.js";
import { toolError } from "../errors.js";

// ---------------------------------------------------------------------------
// public._config table — lazy initialization (org-wide)
// ---------------------------------------------------------------------------

let configReady = false;

async function ensureConfigTable() {
  if (configReady) return;
  await sql(`
    CREATE TABLE IF NOT EXISTS public._config (
      schema_name VARCHAR(255) PRIMARY KEY,
      frontend_enabled BOOLEAN DEFAULT false,
      default_route VARCHAR(500),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  // Migration for existing tables
  await sql(
    `ALTER TABLE public._config ADD COLUMN IF NOT EXISTS default_route VARCHAR(500)`
  );
  configReady = true;
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

// ---------------------------------------------------------------------------
// Exported helpers for frontend route handling
// ---------------------------------------------------------------------------

export async function isFrontendEnabled(schema: string): Promise<boolean> {
  await ensureConfigTable();
  const result = await sql(
    `SELECT frontend_enabled FROM public._config WHERE schema_name = :name`,
    [{ name: "name", value: { stringValue: schema } }]
  );
  return !!(result.records?.length && result.records[0][0].booleanValue);
}

export async function getDefaultRoute(schema: string): Promise<string | null> {
  await ensureConfigTable();
  const result = await sql(
    `SELECT default_route FROM public._config WHERE schema_name = :name`,
    [{ name: "name", value: { stringValue: schema } }]
  );
  if (!result.records?.length) return null;
  const val = result.records[0][0];
  return val.isNull ? null : val.stringValue ?? null;
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerConfigTools(server: McpServer) {
  server.registerTool(
    "enable-frontend",
    {
      title: "Enable Frontend",
      description:
        "Enable web frontend for an app schema. Instant — infrastructure is already provisioned. Returns the public URL. Set default_route to the path users see when visiting the root URL (e.g., '/view/dashboard').",
      inputSchema: {
        schema: z.string().describe("App schema to enable frontend for"),
        default_route: z
          .string()
          .optional()
          .describe("Default route when visiting root URL (e.g., '/view/dashboard')"),
      },
    },
    async ({ schema, default_route }) => {
      if (!isValidIdentifier(schema)) {
        return toolError(
          "INVALID_NAME",
          `Invalid schema name: "${schema}".`
        );
      }

      if (!(await schemaExists(schema))) {
        return toolError(
          "SCHEMA_NOT_FOUND",
          `Schema '${schema}' does not exist. Create it first with create-schema.`
        );
      }

      await ensureConfigTable();

      await sql(
        `INSERT INTO public._config (schema_name, frontend_enabled, default_route)
         VALUES (:name, true, :route)
         ON CONFLICT (schema_name)
         DO UPDATE SET frontend_enabled = true, default_route = COALESCE(:route, public._config.default_route), updated_at = NOW()`,
        [
          { name: "name", value: { stringValue: schema } },
          { name: "route", value: default_route ? { stringValue: default_route } : { isNull: true } },
        ]
      );

      const customDomain = process.env.customDomain ?? "hereya.app";
      const url = `https://${schema}.${customDomain}`;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              schema,
              url,
              frontend_enabled: true,
              default_route: default_route ?? null,
            }),
          },
        ],
      };
    }
  );
}
