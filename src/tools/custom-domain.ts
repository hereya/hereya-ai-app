import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { toolError } from "../errors.js";
import { sql } from "../db.js";
import {
  setCustomDomains,
  checkCustomDomains,
  listCustomDomains,
  CustomDomainError,
} from "../custom-domain.js";

async function schemaExists(schema: string): Promise<boolean> {
  const result = await sql(
    `SELECT 1 FROM information_schema.schemata WHERE schema_name = :name`,
    [{ name: "name", value: { stringValue: schema } }]
  );
  return !!result.records?.length;
}

function handleError(err: unknown) {
  if (err instanceof CustomDomainError) {
    return toolError(err.code, err.message);
  }
  const msg = err instanceof Error ? err.message : String(err);
  return toolError("CLOUDFRONT_UPDATE_FAILED", msg);
}

export function registerCustomDomainTools(server: McpServer) {
  // --- set-custom-domains ---
  server.registerTool(
    "set-custom-domains",
    {
      title: "Set Custom Domains",
      description:
        "Replace the set of custom domains for an app. Provide the full desired list — domains not in the list are removed. Pass an empty array to remove all custom domains for this schema. Issues a new multi-SAN cert and returns validation CNAMEs for any domains not previously active. Next step: user adds the validation records in DNS, then call `check-custom-domains`.",
      inputSchema: {
        schema: z.string().describe("Schema (app) name"),
        domains: z
          .array(z.string())
          .describe(
            "Complete desired list of custom domains for this schema (e.g., ['orders.acme.com', 'acme.com']). Empty array removes all custom domains for the schema."
          ),
      },
    },
    async ({ schema, domains }) => {
      if (!(await schemaExists(schema))) {
        return toolError(
          "SCHEMA_NOT_FOUND",
          `Schema '${schema}' does not exist in this database`
        );
      }
      try {
        const result = await setCustomDomains(schema, domains);
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
        };
      } catch (err) {
        return handleError(err);
      }
    }
  );

  // --- check-custom-domains ---
  server.registerTool(
    "check-custom-domains",
    {
      title: "Check Custom Domains",
      description:
        "Check validation status of any pending custom-domain changes for the given schema. If the pending cert is ISSUED, applies it to CloudFront: swaps the cert, updates the distribution aliases + the subdomain-rewrite function's domain map, and deletes the previous cert. Returns the final routing records the user must add in DNS: `CNAME` for subdomains, `ALIAS`/`ANAME` for apex domains.",
      inputSchema: {
        schema: z.string().describe("Schema (app) name"),
      },
    },
    async ({ schema }) => {
      if (!(await schemaExists(schema))) {
        return toolError(
          "SCHEMA_NOT_FOUND",
          `Schema '${schema}' does not exist in this database`
        );
      }
      try {
        const result = await checkCustomDomains(schema);
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
        };
      } catch (err) {
        return handleError(err);
      }
    }
  );

  // --- list-custom-domains ---
  server.registerTool(
    "list-custom-domains",
    {
      title: "List Custom Domains",
      description:
        "List custom domains. Optionally filter by schema. Read-only.",
      inputSchema: {
        schema: z
          .string()
          .optional()
          .describe("Schema name (omit to list across all schemas)"),
      },
    },
    async ({ schema }) => {
      try {
        const domains = await listCustomDomains(schema);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ domains }, null, 2),
            },
          ],
        };
      } catch (err) {
        return handleError(err);
      }
    }
  );
}
