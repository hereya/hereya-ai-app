import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  SignUpCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { randomUUID } from "crypto";
import { sql } from "./db.js";

// ---------------------------------------------------------------------------
// Per-app Lambda user-management runtime API. Mirrors the MCP add-user /
// remove-user-access / list-users tools so handlers can register users at
// request time (e.g., invite flows, admin dashboards).
// ---------------------------------------------------------------------------

const cognitoClient = new CognitoIdentityProviderClient({
  region: process.env.awsCognitoRegion ?? process.env.awsRegion,
});

let tableReady = false;

async function ensureTable(): Promise<void> {
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
// addUser — create in Cognito (idempotent) + grant schema access
// ---------------------------------------------------------------------------

export async function addUser({
  email,
  schemas,
}: {
  email: string;
  schemas: string[];
}): Promise<{ cognito_created: boolean; schemas_granted: string[] }> {
  if (!email) throw new Error("email is required");
  if (!schemas?.length) throw new Error("at least one schema is required");

  const poolId = process.env.userPoolId;
  const clientId = process.env.userPoolClientId;

  // Per-app Lambdas get USER_POOL_ID when enable-auth has been run for the
  // schema — use AdminCreateUser (the pool is admin-only). For apps still on
  // the shared org pool, fall back to SignUp.
  let cognitoCreated = false;
  try {
    if (poolId) {
      await cognitoClient.send(
        new AdminCreateUserCommand({
          UserPoolId: poolId,
          Username: email,
          MessageAction: "SUPPRESS",
          UserAttributes: [
            { Name: "email", Value: email },
            { Name: "email_verified", Value: "true" },
          ],
        })
      );
      cognitoCreated = true;
    } else if (clientId) {
      await cognitoClient.send(
        new SignUpCommand({
          ClientId: clientId,
          Username: email,
          Password: randomUUID() + "Aa1!",
          UserAttributes: [{ Name: "email", Value: email }],
        })
      );
      cognitoCreated = true;
    } else {
      throw new Error(
        "Neither userPoolId nor userPoolClientId is configured — this Lambda cannot register users."
      );
    }
  } catch (err: any) {
    if (err?.name !== "UsernameExistsException") {
      throw err;
    }
  }

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

  return { cognito_created: cognitoCreated, schemas_granted: schemas };
}

// ---------------------------------------------------------------------------
// removeUserAccess — revoke schema access (does not delete Cognito user)
// ---------------------------------------------------------------------------

export async function removeUserAccess({
  email,
  schemas,
}: {
  email: string;
  schemas: string[];
}): Promise<{ rows_removed: number }> {
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
  return { rows_removed: removed };
}

// ---------------------------------------------------------------------------
// listUsers — list users, optionally filtered by schema
// ---------------------------------------------------------------------------

export async function listUsers(opts?: {
  schema?: string;
}): Promise<{ users: Array<{ email: string; schemas: string[] }>; count: number }> {
  await ensureTable();

  const result = opts?.schema
    ? await sql(
        `SELECT email, schema_name FROM public._user_access
         WHERE schema_name = :schema ORDER BY email`,
        [{ name: "schema", value: { stringValue: opts.schema } }]
      )
    : await sql(
        `SELECT email, schema_name FROM public._user_access
         ORDER BY email, schema_name`
      );

  const userMap = new Map<string, string[]>();
  for (const row of result.records ?? []) {
    const userEmail = row[0].stringValue!;
    const schemaName = row[1].stringValue!;
    if (!userMap.has(userEmail)) userMap.set(userEmail, []);
    userMap.get(userEmail)!.push(schemaName);
  }

  const users = Array.from(userMap.entries()).map(([email, s]) => ({
    email,
    schemas: s,
  }));

  return { users, count: users.length };
}

// ---------------------------------------------------------------------------
// hasAppAccess — quick ACL check used by handlers to gate per-user access
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
