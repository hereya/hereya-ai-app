import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { isValidIdentifier } from "../db.js";
import { toolError } from "../errors.js";
import { isFrontendEnabled } from "./config.js";
import {
  createAppAuth,
  deleteAppAuth,
  migrateSharedPoolUsers,
  getAppAuthStatus,
} from "../app-auth.js";

export function registerAuthTools(server: McpServer) {
  // --- enable-auth ---
  server.registerTool(
    "enable-auth",
    {
      title: "Enable Auth + Mail",
      description:
        "Provision a dedicated Cognito user pool and Postmark email server for an app. Required before end users can sign in to the app's frontend via passwordless email OTP. Call this once per app — resource names are derived from {org, schema} and cannot be customized. Idempotent: returns existing IDs on re-run. Pre-req: enable-frontend.",
      inputSchema: {
        schema: z.string().describe("App schema to provision auth + mail for"),
      },
    },
    async ({ schema }) => {
      if (!isValidIdentifier(schema)) {
        return toolError(
          "INVALID_NAME",
          `Invalid schema name: "${schema}".`
        );
      }

      if (!(await isFrontendEnabled(schema))) {
        return toolError(
          "FRONTEND_NOT_ENABLED",
          `Frontend is not enabled for '${schema}'. Call enable-frontend first.`
        );
      }

      try {
        const result = await createAppAuth(schema);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result),
            },
          ],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        const code =
          msg.toLowerCase().includes("postmark") ? "POSTMARK_ERROR" :
          msg.toLowerCase().includes("cognito") ? "COGNITO_ERROR" :
          msg.toLowerCase().includes("route53") || msg.toLowerCase().includes("hosted zone") ? "DNS_ERROR" :
          "AUTH_PROVISION_FAILED";
        return toolError(code, msg);
      }
    }
  );

  // --- migrate-auth ---
  server.registerTool(
    "migrate-auth",
    {
      title: "Migrate Users from Shared Pool",
      description:
        "Copy users from the legacy shared org Cognito pool into the app's per-app pool. Run once per app after enable-auth. Users are keyed by email; cognito_sub is NOT preserved (Cognito assigns a new sub). App data keyed by cognito_sub must remap — prefer keying by email. Live sessions for this app are invalidated (users re-login via OTP).",
      inputSchema: {
        schema: z.string().describe("App schema to migrate users into"),
        copy_users: z
          .boolean()
          .default(false)
          .describe(
            "Set to true to actually perform the copy. Default is a dry-run that returns 0 counts."
          ),
      },
    },
    async ({ schema, copy_users }) => {
      if (!isValidIdentifier(schema)) {
        return toolError(
          "INVALID_NAME",
          `Invalid schema name: "${schema}".`
        );
      }

      const app = await getAppAuthStatus(schema);
      if (!app) {
        return toolError(
          "AUTH_NOT_ENABLED",
          `enable-auth has not been called for '${schema}'. Run enable-auth first.`
        );
      }

      if (!copy_users) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                dry_run: true,
                message:
                  "Re-run with copy_users=true to perform the migration.",
                target_pool_id: app.user_pool_id,
              }),
            },
          ],
        };
      }

      try {
        const result = await migrateSharedPoolUsers(schema);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                schema,
                target_pool_id: app.user_pool_id,
                ...result,
              }),
            },
          ],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return toolError("MIGRATION_FAILED", msg);
      }
    }
  );

  // --- disable-auth ---
  server.registerTool(
    "disable-auth",
    {
      title: "Disable Auth + Mail",
      description:
        "Tear down the per-app Cognito user pool, Postmark email server, Postmark sender domain, Route 53 DKIM/return-path records, SSM secrets, and API Gateway auth route for an app. Use this to roll back an unwanted enable-auth, or to make a frontend app fully public (no login). DESTRUCTIVE: deletes users registered in the per-app pool. Requires confirm=true. After this, the app's frontend authorizer falls back to the shared org pool (for apps that used it before enable-auth) or is wide-open for handlers that don't enforce auth.",
      inputSchema: {
        schema: z.string().describe("App schema to disable auth for"),
        confirm: z
          .boolean()
          .describe("Must be true to proceed. Safety check."),
      },
    },
    async ({ schema, confirm }) => {
      if (!isValidIdentifier(schema)) {
        return toolError(
          "INVALID_NAME",
          `Invalid schema name: "${schema}".`
        );
      }
      if (!confirm) {
        return toolError(
          "CONFIRMATION_REQUIRED",
          "disable-auth deletes the per-app Cognito pool, Postmark server, DNS records, SSM secrets, and API Gateway auth route. Pass confirm=true to proceed."
        );
      }

      const existing = await getAppAuthStatus(schema);
      if (!existing) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                schema,
                disabled: false,
                message: "Auth was not enabled for this app — nothing to tear down.",
              }),
            },
          ],
        };
      }

      try {
        await deleteAppAuth(schema);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                schema,
                disabled: true,
                deleted: {
                  user_pool_id: existing.user_pool_id,
                  postmark_server_id: existing.postmark_server_id,
                  postmark_domain_id: existing.postmark_domain_id,
                },
              }),
            },
          ],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return toolError("TEARDOWN_FAILED", msg);
      }
    }
  );
}
