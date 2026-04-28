import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  CognitoIdentityProviderClient,
  SignUpCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { randomUUID } from "crypto";
import { sql } from "../db.js";
import { toolError } from "../errors.js";
import {
  createAppBackend,
  redeployAppBackend,
  getAppBackendStatus,
  invokeAppLambda,
  ensureAgentSecret,
  rotateAgentSecret,
} from "../app-lambda.js";
import { mintBootstrapToken } from "../runtime/token-signing.js";

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
// Agent identity + user registration (idempotent) for agent sessions
// ---------------------------------------------------------------------------

let cognitoClient: CognitoIdentityProviderClient | null = null;
function getCognitoClient(): CognitoIdentityProviderClient {
  if (!cognitoClient) {
    cognitoClient = new CognitoIdentityProviderClient({
      region: process.env.awsCognitoRegion ?? process.env.awsRegion,
    });
  }
  return cognitoClient;
}

function agentEmail(orgId: string): string {
  // Deterministic, per-org. Clearly distinguishable from human users.
  return `agent+${orgId}@hereya.agent`;
}

let userAccessTableReady = false;
async function ensureUserAccessTable(): Promise<void> {
  if (userAccessTableReady) return;
  await sql(`
    CREATE TABLE IF NOT EXISTS public._user_access (
      email VARCHAR(255) NOT NULL,
      schema_name VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (email, schema_name)
    )
  `);
  userAccessTableReady = true;
}

async function ensureAgentUserRegistered(
  email: string,
  schema: string
): Promise<void> {
  const clientId = process.env.userPoolClientId;
  if (clientId) {
    try {
      await getCognitoClient().send(
        new SignUpCommand({
          ClientId: clientId,
          Username: email,
          Password: randomUUID() + "Aa1!",
          UserAttributes: [{ Name: "email", Value: email }],
        })
      );
    } catch (err: any) {
      if (err?.name !== "UsernameExistsException") {
        throw err;
      }
    }
  }
  await ensureUserAccessTable();
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

function appUrl(schema: string): string | null {
  const customDomain = process.env.customDomain;
  if (!customDomain) return null;
  return `https://${schema}.${customDomain}`;
}

async function deploymentZipExists(schema: string): Promise<boolean> {
  // Check S3 for the deployment zip by attempting a HEAD request via the storage module
  const { HeadObjectCommand, S3Client } = await import("@aws-sdk/client-s3");
  const client = new S3Client({ region: process.env.awsRegion });
  const pfx = process.env.s3Prefix;
  const key = pfx
    ? `${pfx}/${schema}/backend/deployment.zip`
    : `${schema}/backend/deployment.zip`;

  try {
    await client.send(
      new HeadObjectCommand({ Bucket: process.env.bucketName!, Key: key })
    );
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerDeployTools(server: McpServer) {
  // --- deploy-backend ---
  server.registerTool(
    "deploy-backend",
    {
      title: "Deploy Backend",
      description:
        "Deploy or update a per-app backend Lambda from a deployment zip on S3. " +
        "The zip must already be uploaded to {schema}/backend/deployment.zip. " +
        "First deploy creates the Lambda function and API Gateway routes. " +
        "Subsequent deploys update the Lambda code from the new zip. " +
        "The Lambda has access to Aurora Data API and S3 via the 'hereya' runtime layer.",
      inputSchema: {
        schema: z
          .string()
          .describe("Schema name of the app to deploy backend for"),
      },
    },
    async ({ schema }) => {
      if (!(await schemaExists(schema))) {
        return toolError(
          "SCHEMA_NOT_FOUND",
          `Schema '${schema}' does not exist. Create it first with create-schema.`
        );
      }

      if (!(await deploymentZipExists(schema))) {
        return toolError(
          "FILE_NOT_FOUND",
          `Deployment zip not found at '${schema}/backend/deployment.zip'. ` +
            `Upload a zip containing handler.js to that path first using get-upload-url.`
        );
      }

      const existing = await getAppBackendStatus(schema);

      if (existing) {
        // Redeploy — update Lambda code from S3 zip
        await redeployAppBackend(schema);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                schema,
                deployed: true,
                updated: true,
                function_name: existing.lambda_function_name,
              }),
            },
          ],
        };
      }

      // First deploy — create Lambda + API Gateway routes
      const result = await createAppBackend(schema);

      // Auto-enable frontend
      await sql(
        `INSERT INTO public._config (schema_name, frontend_enabled, default_route)
         VALUES (:schema, true, '/')
         ON CONFLICT (schema_name)
         DO UPDATE SET frontend_enabled = true`,
        [{ name: "schema", value: { stringValue: schema } }]
      );

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              schema,
              deployed: true,
              created: true,
              function_name: result.function_name,
              app_url: result.app_url,
            }),
          },
        ],
      };
    }
  );

  // --- test-backend ---
  server.registerTool(
    "test-backend",
    {
      title: "Test Backend",
      description:
        "Invoke a deployed per-app backend Lambda to test it. " +
        "Sends a synthetic request and returns the response. " +
        "Useful for verifying the handler works before enabling frontend access.",
      inputSchema: {
        schema: z.string().describe("Schema name of the app to test"),
        path: z
          .string()
          .optional()
          .describe("Request path (default: '/')"),
        method: z
          .string()
          .optional()
          .describe("HTTP method (default: 'GET')"),
        body: z
          .string()
          .optional()
          .describe("Request body (for POST/PUT)"),
        query: z
          .record(z.string())
          .optional()
          .describe("Query string parameters"),
      },
    },
    async ({ schema, path, method, body, query: queryParams }, { authInfo }) => {
      const status = await getAppBackendStatus(schema);
      if (!status) {
        return toolError(
          "BACKEND_NOT_FOUND",
          `No backend deployed for schema '${schema}'. Deploy one first with deploy-backend.`
        );
      }

      const reqPath = path ?? "/";
      const reqMethod = method ?? "GET";

      // Extract MCP user info for auth context
      const extra = authInfo?.extra as Record<string, unknown> | undefined;
      const userEmail = (extra?.userId as string) ?? "mcp-test-user";

      // Build a synthetic API Gateway event
      const syntheticEvent = {
        rawPath: `/${schema}${reqPath}`,
        rawQueryString: queryParams
          ? new URLSearchParams(queryParams).toString()
          : "",
        headers: {
          "content-type": body ? "application/json" : "",
        },
        queryStringParameters: queryParams ?? {},
        body: body ?? null,
        isBase64Encoded: false,
        requestContext: {
          http: { method: reqMethod, path: `/${schema}${reqPath}` },
          authorizer: {
            lambda: {
              email: userEmail,
              cognito_sub: "mcp-test",
              public: "false",
            },
          },
        },
      };

      try {
        const response = await invokeAppLambda(schema, syntheticEvent);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                statusCode: response.statusCode,
                headers: response.headers,
                body: response.body,
              }),
            },
          ],
        };
      } catch (err: any) {
        return toolError(
          "INVOKE_ERROR",
          `Failed to invoke backend: ${err.message ?? String(err)}`
        );
      }
    }
  );

  // --- get-agent-session-url ---
  server.registerTool(
    "get-agent-session-url",
    {
      title: "Get Agent Session URL",
      description:
        "Issue a short-lived URL that signs the agent in to a deployed app for visual browser-based testing. " +
        "The URL carries a single-use bootstrap token (5 min TTL); opening it once sets a 30-min HttpOnly session cookie. " +
        "The agent is authenticated as 'agent+{orgId}@hereya.agent' — a real registered user, not a bypass. " +
        "Intended for the agent's own iteration — never share these URLs or post them publicly.",
      inputSchema: {
        schema: z.string().describe("Schema name of the app to open"),
        path: z
          .string()
          .optional()
          .describe("Path to land on after bootstrap (default: '/')"),
      },
    },
    async ({ schema, path }, { authInfo }) => {
      if (!(await schemaExists(schema))) {
        return toolError(
          "SCHEMA_NOT_FOUND",
          `Schema '${schema}' does not exist.`
        );
      }
      const status = await getAppBackendStatus(schema);
      if (!status) {
        return toolError(
          "BACKEND_NOT_FOUND",
          `No backend deployed for schema '${schema}'. Deploy one first with deploy-backend.`
        );
      }

      const extra = authInfo?.extra as Record<string, unknown> | undefined;
      const orgId =
        (extra?.orgId as string) ??
        process.env.BOUND_ORG_ID ??
        process.env.ORGANIZATION_ID ??
        "default";

      const email = agentEmail(orgId);

      try {
        await ensureAgentUserRegistered(email, schema);
      } catch (err: any) {
        return toolError(
          "COGNITO_ERROR",
          `Failed to register agent identity: ${err.message ?? String(err)}`
        );
      }

      let secret: string;
      try {
        secret = await ensureAgentSecret(schema);
      } catch (err: any) {
        return toolError(
          "SSM_ERROR",
          `Failed to load agent signing secret: ${err.message ?? String(err)}`
        );
      }

      const { token, exp } = mintBootstrapToken(secret, { schema, email });

      const url = appUrl(schema);
      if (!url) {
        return toolError(
          "CONFIG_ERROR",
          "customDomain is not configured — cannot build an agent session URL. Deploy with a custom domain."
        );
      }

      const redirect = path ?? "/";
      const bootstrapUrl = `${url}/__hereya/agent-bootstrap?token=${encodeURIComponent(
        token
      )}&redirect=${encodeURIComponent(redirect)}`;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              url: bootstrapUrl,
              email,
              bootstrap_expires_at: new Date(exp * 1000).toISOString(),
              bootstrap_ttl_seconds: 300,
              session_ttl_seconds: 1800,
              note: "Open this URL in a browser. It is single-use and expires in 5 minutes. The resulting session cookie expires in 30 minutes.",
            }),
          },
        ],
      };
    }
  );

  // --- revoke-agent-sessions ---
  server.registerTool(
    "revoke-agent-sessions",
    {
      title: "Revoke Agent Sessions",
      description:
        "Rotate the agent-session signing secret for an app. All outstanding agent bootstrap tokens and session cookies immediately become invalid. " +
        "Use this as a kill switch if you suspect an agent session URL was leaked, or as a hygiene step before sharing test access.",
      inputSchema: {
        schema: z.string().describe("Schema name of the app"),
      },
    },
    async ({ schema }) => {
      const status = await getAppBackendStatus(schema);
      if (!status) {
        return toolError(
          "BACKEND_NOT_FOUND",
          `No backend deployed for schema '${schema}'.`
        );
      }
      try {
        await rotateAgentSecret(schema);
      } catch (err: any) {
        return toolError(
          "ROTATE_ERROR",
          `Failed to rotate agent secret: ${err.message ?? String(err)}`
        );
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              schema,
              rotated: true,
              note: "Warm Lambda containers will recycle on next request; all existing agent cookies now fail verification.",
            }),
          },
        ],
      };
    }
  );
}
