import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { sql } from "../db.js";
import { describeSchemaStructure } from "../schema-utils.js";
import { toolError } from "../errors.js";

// Current runtime-layer contract. Appended to get-skill responses when the
// app has a deployed backend, so agents editing a handler always see the
// up-to-date platform API even if the per-app skill body is stale.
const RUNTIME_CONTRACT = `This app has a deployed backend Lambda. The per-app skill above may predate recent runtime-layer changes — the invariants below override anything the skill says about the \`hereya\` runtime.

## hereya runtime layer — current contract

Every handler.js MUST follow this shape:

\`\`\`js
const { handleAgentBootstrap, parseRequest, sql, query, convertParams } = require('hereya');

exports.handler = async (event) => {
  // 1. Bootstrap check — MUST be first. Consumes agent-session preview URLs.
  const bootstrap = await handleAgentBootstrap(event);
  if (bootstrap) return bootstrap;

  // 2. parseRequest is ASYNC — the await is required.
  //    Without it, req is a Promise, req.path is undefined, and every route collapses to "/".
  const req = await parseRequest(event);

  // ... your routing ...
};
\`\`\`

### Async functions (always \`await\`)
- \`handleAgentBootstrap(event)\` — returns a 302 response or null
- \`parseRequest(event)\` — returns \`{ path, method, headers, query, body, auth, schema }\`
- \`sql(query, params?)\` — raw Data API result
- \`query(query, params?)\` — \`{ columns, rows, row_count }\` with rows as objects
- \`storage.*\` — all S3 operations
- \`users.*\` — Cognito + ACL operations

### Sync helpers
- \`convertParams(obj)\` — converts \`{ key: value }\` to Data API format

### Response format
Standard API Gateway response: \`{ statusCode, headers, body }\`.

### Symptoms of forgetting \`await parseRequest\`
All paths return the same response (usually the "/" handler). \`/styles.css\`, \`/app.js\`, every unknown route — all serve the landing HTML.

For the full workflow (bundling, zip layout, deploy, test), call \`get-instructions({ topic: "frontend" })\`.`;

async function hasDeployedBackend(schema: string): Promise<boolean> {
  try {
    const result = await sql(
      `SELECT 1 FROM public._app_backends WHERE schema_name = :schema LIMIT 1`,
      [{ name: "schema", value: { stringValue: schema } }]
    );
    return !!result.records?.length;
  } catch {
    // Table may not exist yet — no backends deployed anywhere.
    return false;
  }
}

// ---------------------------------------------------------------------------
// Internal _hereya schema — lazy initialization
// ---------------------------------------------------------------------------

let schemaReady = false;

async function ensureHereyaSchema() {
  if (schemaReady) return;
  await sql(`CREATE SCHEMA IF NOT EXISTS _hereya`);
  await sql(`
    CREATE TABLE IF NOT EXISTS _hereya.skills (
      id SERIAL PRIMARY KEY,
      schema_name VARCHAR(63) NOT NULL,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      content TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(schema_name, name)
    )
  `);
  schemaReady = true;
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerSkillTools(server: McpServer) {
  // --- save-skill ---
  server.registerTool(
    "save-skill",
    {
      title: "Save Skill",
      description:
        "Save or update a skill for an app. A skill is a set of instructions that tells agents how to use the app. Multiple skills per schema are supported.",
      inputSchema: {
        schema: z.string().describe("Schema (app) name the skill belongs to"),
        name: z.string().describe("Skill name (e.g., 'main', 'cost-analysis', 'meal-planning')"),
        description: z
          .string()
          .optional()
          .describe("Short one-line description of what this skill does"),
        content: z
          .string()
          .describe("Full skill content (markdown). See get-instructions({ topic: 'write-skill' }) for guidance."),
      },
    },
    async ({ schema, name, description, content }) => {
      // Validate schema exists
      const schemaCheck = await sql(
        `SELECT 1 FROM information_schema.schemata WHERE schema_name = :name`,
        [{ name: "name", value: { stringValue: schema } }]
      );
      if (!schemaCheck.records?.length) {
        return toolError(
          "SCHEMA_NOT_FOUND",
          `Schema '${schema}' does not exist. Create it first with create-schema.`
        );
      }

      await ensureHereyaSchema();

      await sql(
        `INSERT INTO _hereya.skills (schema_name, name, description, content)
         VALUES (:schema, :name, :desc, :content)
         ON CONFLICT (schema_name, name)
         DO UPDATE SET content = :content, description = :desc, updated_at = NOW()`,
        [
          { name: "schema", value: { stringValue: schema } },
          { name: "name", value: { stringValue: name } },
          { name: "desc", value: description ? { stringValue: description } : { isNull: true } },
          { name: "content", value: { stringValue: content } },
        ]
      );

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ schema, name, saved: true }),
          },
        ],
      };
    }
  );

  // --- get-skill ---
  server.registerTool(
    "get-skill",
    {
      title: "Get Skill",
      description:
        "Get a skill's content and the schema structure in one call. Returns both the skill instructions and the full table/column definitions.",
      inputSchema: {
        schema: z.string().describe("Schema (app) name"),
        name: z.string().describe("Skill name"),
      },
    },
    async ({ schema, name }) => {
      await ensureHereyaSchema();

      const result = await sql(
        `SELECT name, description, content, updated_at
         FROM _hereya.skills
         WHERE schema_name = :schema AND name = :name`,
        [
          { name: "schema", value: { stringValue: schema } },
          { name: "name", value: { stringValue: name } },
        ]
      );

      if (!result.records?.length) {
        return toolError(
          "SKILL_NOT_FOUND",
          `Skill '${name}' not found for schema '${schema}'`
        );
      }

      const row = result.records[0];
      const skill = {
        name: row[0].stringValue,
        description: row[1].isNull ? null : row[1].stringValue,
        content: row[2].stringValue,
        updated_at: row[3].stringValue,
      };

      // Also fetch schema structure
      const schemaStructure = await describeSchemaStructure(schema);

      // Include the current runtime-layer contract when a backend is deployed,
      // so agents editing a handler get the up-to-date platform API even if
      // the per-app skill body predates recent breaking changes.
      const runtimeContract = (await hasDeployedBackend(schema))
        ? RUNTIME_CONTRACT
        : undefined;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                skill,
                schema_structure: schemaStructure,
                ...(runtimeContract ? { runtime_contract: runtimeContract } : {}),
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // --- list-skills ---
  server.registerTool(
    "list-skills",
    {
      title: "List Skills",
      description:
        "List all skills. Optionally filter by schema. Returns skill metadata (not full content).",
      inputSchema: {
        schema: z
          .string()
          .optional()
          .describe("Filter by schema (app) name. Omit to list all."),
      },
    },
    async ({ schema }) => {
      await ensureHereyaSchema();

      let query: string;
      let params: any[] | undefined;

      if (schema) {
        query = `SELECT schema_name, name, description, updated_at
                 FROM _hereya.skills
                 WHERE schema_name = :schema
                 ORDER BY schema_name, name`;
        params = [{ name: "schema", value: { stringValue: schema } }];
      } else {
        query = `SELECT schema_name, name, description, updated_at
                 FROM _hereya.skills
                 ORDER BY schema_name, name`;
      }

      const result = await sql(query, params);

      const skills = (result.records ?? []).map((row) => ({
        schema: row[0].stringValue,
        name: row[1].stringValue,
        description: row[2].isNull ? null : row[2].stringValue,
        updated_at: row[3].stringValue,
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ skills }),
          },
        ],
      };
    }
  );

  // --- delete-skill ---
  server.registerTool(
    "delete-skill",
    {
      title: "Delete Skill",
      description: "Delete a skill.",
      inputSchema: {
        schema: z.string().describe("Schema (app) name"),
        name: z.string().describe("Skill name"),
      },
    },
    async ({ schema, name }) => {
      await ensureHereyaSchema();

      const result = await sql(
        `DELETE FROM _hereya.skills
         WHERE schema_name = :schema AND name = :name`,
        [
          { name: "schema", value: { stringValue: schema } },
          { name: "name", value: { stringValue: name } },
        ]
      );

      if ((result.numberOfRecordsUpdated ?? 0) === 0) {
        return toolError(
          "SKILL_NOT_FOUND",
          `Skill '${name}' not found for schema '${schema}'`
        );
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ schema, name, deleted: true }),
          },
        ],
      };
    }
  );
}

/**
 * Delete all skills for a given schema. Called by drop-schema.
 */
export async function deleteSkillsForSchema(schema: string): Promise<void> {
  // Only attempt if _hereya schema exists
  try {
    await ensureHereyaSchema();
    await sql(
      `DELETE FROM _hereya.skills WHERE schema_name = :schema`,
      [{ name: "schema", value: { stringValue: schema } }]
    );
  } catch {
    // Best effort — _hereya schema might not exist yet
  }
}
