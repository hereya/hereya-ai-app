import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { sql } from "../db.js";
import { toolError } from "../errors.js";
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  SignUpCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { randomUUID } from "crypto";
import { getAppAuthStatus } from "../app-auth.js";

// ---------------------------------------------------------------------------
// Cognito client
// ---------------------------------------------------------------------------

const cognitoClient = new CognitoIdentityProviderClient({
  region: process.env.awsCognitoRegion ?? process.env.awsRegion,
});

// ---------------------------------------------------------------------------
// public._user_access table — lazy initialization
// ---------------------------------------------------------------------------

let tableReady = false;

async function ensureTable() {
  if (tableReady) return;
  await sql(`
    CREATE TABLE IF NOT EXISTS public._user_access (
      email VARCHAR(255) NOT NULL,
      schema_name VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (email, schema_name)
    )
  `);
  tableReady = true;
}

// ---------------------------------------------------------------------------
// Exported helper for frontend route handling
// ---------------------------------------------------------------------------

export async function hasAppAccess(
  email: string,
  schema: string
): Promise<boolean> {
  await ensureTable();
  const result = await sql(
    `SELECT 1 FROM public._user_access WHERE email = :email AND schema_name = :schema`,
    [
      { name: "email", value: { stringValue: email } },
      { name: "schema", value: { stringValue: schema } },
    ]
  );
  return !!(result.records?.length);
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerUserTools(server: McpServer) {
  // --- add-user ---
  server.registerTool(
    "add-user",
    {
      title: "Add User",
      description:
        "Register a user in the authentication pool and grant access to specific apps. The user will be able to log in via email OTP and access the specified app frontends.",
      inputSchema: {
        email: z.string().describe("User email address"),
        schemas: z
          .array(z.string())
          .describe("App schemas to grant access to"),
      },
    },
    async ({ email, schemas }) => {
      if (!email || !schemas.length) {
        return toolError("INVALID_INPUT", "Email and at least one schema are required.");
      }

      const sharedPoolId = process.env.userPoolId;
      const sharedClientId = process.env.userPoolClientId;

      // Each schema may have its own per-app Cognito pool (after enable-auth)
      // or fall back to the shared org pool. Register the user once per
      // distinct pool. AdminCreateUser is used for per-app pools (they are
      // locked to AllowAdminCreateUserOnly=true); SignUp is used for the
      // legacy shared pool which still allows public signup.
      const registeredIn = new Set<string>();
      const poolsUsed: string[] = [];
      let cognitoCreated = false;

      for (const schema of schemas) {
        const appAuth = await getAppAuthStatus(schema);

        if (appAuth) {
          // Per-app pool — AdminCreateUser (pool is admin-only).
          if (registeredIn.has(appAuth.user_pool_id)) continue;
          registeredIn.add(appAuth.user_pool_id);
          poolsUsed.push(`per-app (${appAuth.user_pool_id})`);

          try {
            await cognitoClient.send(
              new AdminCreateUserCommand({
                UserPoolId: appAuth.user_pool_id,
                Username: email,
                MessageAction: "SUPPRESS",
                UserAttributes: [
                  { Name: "email", Value: email },
                  { Name: "email_verified", Value: "true" },
                ],
              })
            );
            cognitoCreated = true;
          } catch (err: any) {
            if (err.name === "UsernameExistsException") {
              // Already registered in that pool — fine.
            } else {
              return toolError(
                "COGNITO_ERROR",
                `Failed to create user in per-app pool for '${schema}': ${err.message}`
              );
            }
          }
        } else {
          // Legacy shared pool — SignUp (kept for backward compat).
          if (!sharedClientId) {
            return toolError(
              "CONFIG_ERROR",
              `No Cognito pool available for schema '${schema}' — run enable-auth.`
            );
          }
          if (registeredIn.has(sharedClientId)) continue;
          registeredIn.add(sharedClientId);
          poolsUsed.push(`shared (${sharedPoolId ?? "unknown"})`);

          try {
            await cognitoClient.send(
              new SignUpCommand({
                ClientId: sharedClientId,
                Username: email,
                Password: randomUUID() + "Aa1!",
                UserAttributes: [{ Name: "email", Value: email }],
              })
            );
            cognitoCreated = true;
          } catch (err: any) {
            if (err.name === "UsernameExistsException") {
              // Already registered in that pool — fine.
            } else {
              return toolError(
                "COGNITO_ERROR",
                `Failed to create user in shared pool for '${schema}': ${err.message}`
              );
            }
          }
        }
      }

      // Grant app access in DB (independent of which pool)
      await ensureTable();
      for (const schema of schemas) {
        await sql(
          `INSERT INTO public._user_access (email, schema_name)
           VALUES (:email, :schema)
           ON CONFLICT (email, schema_name) DO NOTHING`,
          [
            { name: "email", value: { stringValue: email } },
            { name: "schema", value: { stringValue: schema } },
          ]
        );
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              email,
              cognito_created: cognitoCreated,
              schemas_granted: schemas,
              pools: poolsUsed,
            }),
          },
        ],
      };
    }
  );

  // --- remove-user-access ---
  server.registerTool(
    "remove-user-access",
    {
      title: "Remove User Access",
      description:
        "Revoke a user's access to specific apps. Does not delete the user from the authentication pool.",
      inputSchema: {
        email: z.string().describe("User email address"),
        schemas: z
          .array(z.string())
          .describe("App schemas to revoke access from"),
      },
    },
    async ({ email, schemas }) => {
      await ensureTable();

      let removed = 0;
      for (const schema of schemas) {
        const result = await sql(
          `DELETE FROM public._user_access WHERE email = :email AND schema_name = :schema`,
          [
            { name: "email", value: { stringValue: email } },
            { name: "schema", value: { stringValue: schema } },
          ]
        );
        removed += result.numberOfRecordsUpdated ?? 0;
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ email, schemas_revoked: schemas, rows_removed: removed }),
          },
        ],
      };
    }
  );

  // --- list-users ---
  server.registerTool(
    "list-users",
    {
      title: "List Users",
      description:
        "List users and their app access. Optionally filter by app schema.",
      inputSchema: {
        schema: z
          .string()
          .optional()
          .describe("Filter by app schema. Omit to list all users."),
      },
    },
    async ({ schema }) => {
      await ensureTable();

      let result;
      if (schema) {
        result = await sql(
          `SELECT email, schema_name FROM public._user_access WHERE schema_name = :schema ORDER BY email`,
          [{ name: "schema", value: { stringValue: schema } }]
        );
      } else {
        result = await sql(
          `SELECT email, schema_name FROM public._user_access ORDER BY email, schema_name`
        );
      }

      // Group by email
      const userMap = new Map<string, string[]>();
      for (const row of result.records ?? []) {
        const userEmail = row[0].stringValue!;
        const schemaName = row[1].stringValue!;
        if (!userMap.has(userEmail)) userMap.set(userEmail, []);
        userMap.get(userEmail)!.push(schemaName);
      }

      const users = Array.from(userMap.entries()).map(([e, s]) => ({
        email: e,
        schemas: s,
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ users, count: users.length }),
          },
        ],
      };
    }
  );
}
