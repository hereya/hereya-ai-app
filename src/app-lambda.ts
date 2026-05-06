import {
  LambdaClient,
  CreateFunctionCommand,
  UpdateFunctionCodeCommand,
  UpdateFunctionConfigurationCommand,
  GetFunctionConfigurationCommand,
  DeleteFunctionCommand,
  GetFunctionCommand,
  AddPermissionCommand,
  RemovePermissionCommand,
  waitUntilFunctionUpdatedV2,
} from "@aws-sdk/client-lambda";
import {
  ApiGatewayV2Client,
  CreateIntegrationCommand,
  CreateRouteCommand,
  DeleteRouteCommand,
  DeleteIntegrationCommand,
} from "@aws-sdk/client-apigatewayv2";
import { randomBytes } from "crypto";
import { sql } from "./db.js";
import {
  getParameter,
  putParameter,
  deleteParameter,
  invalidateCache,
} from "./ssm.js";
import { ensureAuthRoute } from "./app-auth.js";
import { ensureCustomDomainsTable } from "./custom-domain.js";
import { getAppAuthStatus } from "./app-auth.js";

// ---------------------------------------------------------------------------
// Config from environment
// ---------------------------------------------------------------------------

const region = () => process.env.awsRegion!;
const accountId = () => process.env.AWS_ACCOUNT_ID!;
const appLambdaRoleArn = () => process.env.APP_LAMBDA_ROLE_ARN!;
const appLambdaNamePrefix = () => process.env.APP_LAMBDA_NAME_PREFIX!;
const appLambdaLayerArn = () => process.env.APP_LAMBDA_LAYER_ARN!;
const httpApiId = () => process.env.HTTP_API_ID!;
const frontendAuthorizerId = () => process.env.FRONTEND_AUTHORIZER_ID!;
const authIntegrationId = () => process.env.AUTH_INTEGRATION_ID!;
const organizationId = () => process.env.ORGANIZATION_ID!;
const agentSecretSsmPrefix = () =>
  process.env.AGENT_SECRET_SSM_PREFIX ?? `/hereya/${organizationId()}/apps`;

const lambdaFunctionName = (schema: string) =>
  `${appLambdaNamePrefix()}${schema}`;

export function agentSecretSsmPath(schema: string): string {
  return `${agentSecretSsmPrefix()}/${schema}/agent-secret`;
}

// Lazy clients
let _lambda: LambdaClient | undefined;
let _apigw: ApiGatewayV2Client | undefined;

function lambdaClient(): LambdaClient {
  if (!_lambda) _lambda = new LambdaClient({ region: region() });
  return _lambda;
}

function apigwClient(): ApiGatewayV2Client {
  if (!_apigw) _apigw = new ApiGatewayV2Client({ region: region() });
  return _apigw;
}

// ---------------------------------------------------------------------------
// DB table for tracking per-app backends
// ---------------------------------------------------------------------------

let tableReady = false;

async function ensureTable(): Promise<void> {
  if (tableReady) return;
  await sql(`
    CREATE TABLE IF NOT EXISTS public._app_backends (
      schema_name VARCHAR(255) PRIMARY KEY,
      lambda_function_name VARCHAR(255) NOT NULL,
      integration_id VARCHAR(255),
      route_ids JSONB,
      last_deployed_at TIMESTAMP DEFAULT NOW()
    )
  `);
  tableReady = true;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DeployResult {
  function_name: string;
  app_url: string;
  created: boolean;
}

export interface BackendStatus {
  schema_name: string;
  lambda_function_name: string;
  last_deployed_at: string;
}

// ---------------------------------------------------------------------------
// Build per-app Lambda environment variables
// ---------------------------------------------------------------------------

async function buildAppEnv(schema: string): Promise<Record<string, string>> {
  const env: Record<string, string> = {
    clusterArn: process.env.clusterArn!,
    secretArn: process.env.secretArn!,
    databaseName: process.env.databaseName!,
    bucketName: process.env.bucketName!,
    s3Prefix: process.env.s3Prefix!,
    awsRegion: region(),
    APP_SCHEMA: schema,
    customDomain: process.env.customDomain ?? "",
    ORGANIZATION_ID: organizationId(),
    AGENT_SECRET_SSM_PATH: agentSecretSsmPath(schema),
  };

  // If enable-auth has run for this schema, inject the per-app Cognito pool
  // client. Otherwise fall back to the shared-pool env vars (Phase-A migration
  // — see /plans/i-need-to-add-serialized-mountain.md).
  const appAuth = await getAppAuthStatus(schema);
  if (appAuth) {
    env.userPoolId = appAuth.user_pool_id;
    env.userPoolClientId = appAuth.user_pool_client_id;
    env.awsCognitoRegion = region();

    // Mail: runtime mail.send helper reads the per-app Postmark server token
    // from SSM (scoped by IAM to /hereya/{orgId}/apps/*/auth/*) and writes
    // the From header as {local-part}@{POSTMARK_FROM_DOMAIN}. POSTMARK_FROM_DOMAIN
    // is the exact domain Postmark has a verified signature for.
    const defaultFromDomain = appAuth.from_email.split("@")[1];
    env.POSTMARK_SERVER_TOKEN_SSM_PATH = `${agentSecretSsmPrefix()}/${schema}/auth/postmark-server-token`;
    env.POSTMARK_FROM_DOMAIN = defaultFromDomain;
    if (process.env.postmarkApiBaseUrl) {
      env.postmarkApiBaseUrl = process.env.postmarkApiBaseUrl;
    }

    // POSTMARK_FROM_DOMAIN_ALLOW — the set of sender domains the runtime
    // mail.send helper will accept in `from_domain`. Starts with the
    // internal default, then adds every _custom_domains row for this
    // schema whose email_status = 'active'. Refreshed on every
    // deploy/redeploy — agents must redeploy the backend after a custom
    // domain flips to active to pick up the update.
    try {
      await ensureCustomDomainsTable();
      const allowed = await sql(
        `SELECT domain FROM public._custom_domains
          WHERE schema_name = :schema AND email_status = 'active'`,
        [{ name: "schema", value: { stringValue: schema } }]
      );
      const domains = [
        defaultFromDomain.toLowerCase(),
        ...((allowed.records ?? [])
          .map((r) => r[0]?.stringValue)
          .filter(
            (d): d is string => typeof d === "string" && d.length > 0
          )
          .map((d) => d.toLowerCase())),
      ];
      env.POSTMARK_FROM_DOMAIN_ALLOW = [...new Set(domains)].join(",");
    } catch {
      // table may not exist yet (brand-new orgs) — fall back to default only
      env.POSTMARK_FROM_DOMAIN_ALLOW = defaultFromDomain.toLowerCase();
    }
  } else {
    if (process.env.userPoolClientId) {
      env.userPoolClientId = process.env.userPoolClientId;
    }
    if (process.env.awsCognitoRegion) {
      env.awsCognitoRegion = process.env.awsCognitoRegion;
    }
  }
  return env;
}

// ---------------------------------------------------------------------------
// Agent secret lifecycle — SSM SecureString per schema
// ---------------------------------------------------------------------------

function generateAgentSecret(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Ensure an agent secret exists in SSM for this schema. Generates one if
 * missing (idempotent via PutParameter Overwrite=false race-tolerant retry on
 * GetParameter). Returns the current secret value.
 */
export async function ensureAgentSecret(schema: string): Promise<string> {
  const path = agentSecretSsmPath(schema);
  const existing = await getParameter(path);
  if (existing) return existing;

  const fresh = generateAgentSecret();
  try {
    await putParameter(path, fresh, { overwrite: false });
    return fresh;
  } catch (err: any) {
    // Lost the race — someone else wrote it. Fetch the winner.
    if (err?.name === "ParameterAlreadyExists") {
      const after = await getParameter(path);
      if (after) return after;
    }
    throw err;
  }
}

/**
 * Rotate the agent secret and force running per-app Lambda containers to
 * recycle so they re-read the new value on next request. Any live agent
 * cookies signed with the old secret will fail HMAC verification.
 */
export async function rotateAgentSecret(schema: string): Promise<void> {
  const path = agentSecretSsmPath(schema);
  const fresh = generateAgentSecret();
  await putParameter(path, fresh, { overwrite: true });
  invalidateCache(path);

  // Touch the Lambda env to trigger container recycling.
  const fnName = lambdaFunctionName(schema);
  const current = await lambdaClient().send(
    new GetFunctionConfigurationCommand({ FunctionName: fnName })
  );
  const vars = { ...(current.Environment?.Variables ?? {}) };
  vars.AGENT_SECRET_ROTATED_AT = new Date().toISOString();
  await lambdaClient().send(
    new UpdateFunctionConfigurationCommand({
      FunctionName: fnName,
      Environment: { Variables: vars },
    })
  );
}

// ---------------------------------------------------------------------------
// S3 location for deployment zip
// ---------------------------------------------------------------------------

function deploymentZipKey(schema: string): string {
  const pfx = process.env.s3Prefix;
  const path = `${schema}/backend/deployment.zip`;
  return pfx ? `${pfx}/${path}` : path;
}

// ---------------------------------------------------------------------------
// createAppBackend — first deploy
// ---------------------------------------------------------------------------

export async function createAppBackend(
  schema: string
): Promise<DeployResult> {
  await ensureTable();

  const fnName = lambdaFunctionName(schema);
  const s3Bucket = process.env.bucketName!;
  const s3Key = deploymentZipKey(schema);

  // 0. Ensure the agent-session signing secret exists in SSM before the
  //    per-app Lambda starts. Safe to call repeatedly (idempotent).
  await ensureAgentSecret(schema);

  // 1. Create Lambda function
  await lambdaClient().send(
    new CreateFunctionCommand({
      FunctionName: fnName,
      Runtime: "nodejs22.x",
      Handler: "handler.handler",
      Code: { S3Bucket: s3Bucket, S3Key: s3Key },
      Role: appLambdaRoleArn(),
      Layers: [appLambdaLayerArn()],
      Environment: { Variables: await buildAppEnv(schema) },
      MemorySize: 256,
      Timeout: 60,
    })
  );

  // 2. Grant API Gateway permission to invoke the Lambda
  await lambdaClient().send(
    new AddPermissionCommand({
      FunctionName: fnName,
      StatementId: "ApiGatewayInvoke",
      Action: "lambda:InvokeFunction",
      Principal: "apigateway.amazonaws.com",
      SourceArn: `arn:aws:execute-api:${region()}:${accountId()}:${httpApiId()}/*/*`,
    })
  );

  // 3. Create API Gateway integration for per-app Lambda
  const integration = await apigwClient().send(
    new CreateIntegrationCommand({
      ApiId: httpApiId(),
      IntegrationType: "AWS_PROXY",
      IntegrationUri: `arn:aws:lambda:${region()}:${accountId()}:function:${fnName}`,
      PayloadFormatVersion: "2.0",
    })
  );
  const integrationId = integration.IntegrationId!;

  // 4. Create 3 API Gateway routes
  const routeIds: string[] = [];

  // Route: ANY /{schema} (root)
  const rootRoute = await apigwClient().send(
    new CreateRouteCommand({
      ApiId: httpApiId(),
      RouteKey: `ANY /${schema}`,
      Target: `integrations/${integrationId}`,
      AuthorizationType: "CUSTOM",
      AuthorizerId: frontendAuthorizerId(),
    })
  );
  routeIds.push(rootRoute.RouteId!);

  // Route: ANY /{schema}/{proxy+} (sub-paths)
  const proxyRoute = await apigwClient().send(
    new CreateRouteCommand({
      ApiId: httpApiId(),
      RouteKey: `ANY /${schema}/{proxy+}`,
      Target: `integrations/${integrationId}`,
      AuthorizationType: "CUSTOM",
      AuthorizerId: frontendAuthorizerId(),
    })
  );
  routeIds.push(proxyRoute.RouteId!);

  // Route: ANY /{schema}/auth/{proxy+} (auth — uses shared auth Lambda).
  // ensureAuthRoute is idempotent so enable-auth and deploy-backend can run
  // in either order without conflicting on this route.
  const authRouteId = await ensureAuthRoute(schema);
  routeIds.push(authRouteId);

  // 5. Store in DB
  await sql(
    `INSERT INTO public._app_backends (schema_name, lambda_function_name, integration_id, route_ids, last_deployed_at)
     VALUES (:schema, :fn, :integ, :routes::jsonb, NOW())
     ON CONFLICT (schema_name)
     DO UPDATE SET lambda_function_name = :fn, integration_id = :integ, route_ids = :routes::jsonb, last_deployed_at = NOW()`,
    [
      { name: "schema", value: { stringValue: schema } },
      { name: "fn", value: { stringValue: fnName } },
      { name: "integ", value: { stringValue: integrationId } },
      { name: "routes", value: { stringValue: JSON.stringify(routeIds) } },
    ]
  );

  const customDomain = process.env.customDomain;
  const appUrl = customDomain
    ? `https://${schema}.${customDomain}`
    : `(deploy with custom domain for app URL)`;

  return { function_name: fnName, app_url: appUrl, created: true };
}

// ---------------------------------------------------------------------------
// redeployAppBackend — update code from S3 zip
// ---------------------------------------------------------------------------

export async function redeployAppBackend(schema: string): Promise<void> {
  const fnName = lambdaFunctionName(schema);
  const s3Bucket = process.env.bucketName!;
  const s3Key = deploymentZipKey(schema);

  // Make sure the signing secret exists before we potentially refresh the
  // Lambda env (safe-no-op when it already exists).
  await ensureAgentSecret(schema);

  // Wait until any in-flight update from a previous deploy has settled.
  // Lambda rejects back-to-back updates with ResourceConflictException while
  // LastUpdateStatus is "InProgress".
  await waitUntilFunctionUpdatedV2(
    { client: lambdaClient(), maxWaitTime: 120 },
    { FunctionName: fnName }
  );

  // Refresh config first so redeployed apps pick up new runtime layer versions
  // and any env vars introduced since the app was first deployed.
  await lambdaClient().send(
    new UpdateFunctionConfigurationCommand({
      FunctionName: fnName,
      Layers: [appLambdaLayerArn()],
      Environment: { Variables: await buildAppEnv(schema) },
      Timeout: 60,
    })
  );

  // Config update flips LastUpdateStatus back to InProgress — wait before
  // issuing the code update or it fails with "update is in progress".
  await waitUntilFunctionUpdatedV2(
    { client: lambdaClient(), maxWaitTime: 120 },
    { FunctionName: fnName }
  );

  await lambdaClient().send(
    new UpdateFunctionCodeCommand({
      FunctionName: fnName,
      S3Bucket: s3Bucket,
      S3Key: s3Key,
    })
  );

  await ensureTable();
  await sql(
    `UPDATE public._app_backends SET last_deployed_at = NOW() WHERE schema_name = :schema`,
    [{ name: "schema", value: { stringValue: schema } }]
  );
}

// ---------------------------------------------------------------------------
// deleteAppBackend — remove Lambda + routes + integration
// ---------------------------------------------------------------------------

export async function deleteAppBackend(schema: string): Promise<void> {
  await ensureTable();

  // Look up from DB
  const result = await sql(
    `SELECT lambda_function_name, integration_id, route_ids
     FROM public._app_backends WHERE schema_name = :schema`,
    [{ name: "schema", value: { stringValue: schema } }]
  );

  if (!result.records?.length) return; // no backend deployed

  const fnName = result.records[0][0].stringValue!;
  const integrationId = result.records[0][1].stringValue;
  const routeIds: string[] = result.records[0][2].stringValue
    ? JSON.parse(result.records[0][2].stringValue)
    : [];

  // Delete routes
  for (const routeId of routeIds) {
    try {
      await apigwClient().send(
        new DeleteRouteCommand({ ApiId: httpApiId(), RouteId: routeId })
      );
    } catch {
      // Route may already be deleted
    }
  }

  // Delete integration
  if (integrationId) {
    try {
      await apigwClient().send(
        new DeleteIntegrationCommand({
          ApiId: httpApiId(),
          IntegrationId: integrationId,
        })
      );
    } catch {
      // Integration may already be deleted
    }
  }

  // Remove API Gateway invoke permission
  try {
    await lambdaClient().send(
      new RemovePermissionCommand({
        FunctionName: fnName,
        StatementId: "ApiGatewayInvoke",
      })
    );
  } catch {
    // Permission may not exist
  }

  // Delete Lambda function
  try {
    await lambdaClient().send(
      new DeleteFunctionCommand({ FunctionName: fnName })
    );
  } catch {
    // Function may already be deleted
  }

  // Delete DB record
  await sql(
    `DELETE FROM public._app_backends WHERE schema_name = :schema`,
    [{ name: "schema", value: { stringValue: schema } }]
  );

  // Delete the agent-session signing secret (best effort).
  try {
    await deleteParameter(agentSecretSsmPath(schema));
  } catch {
    // Parameter may already be gone
  }
}

// ---------------------------------------------------------------------------
// getAppBackendStatus — check if backend exists
// ---------------------------------------------------------------------------

export async function getAppBackendStatus(
  schema: string
): Promise<BackendStatus | null> {
  await ensureTable();

  const result = await sql(
    `SELECT schema_name, lambda_function_name, last_deployed_at
     FROM public._app_backends WHERE schema_name = :schema`,
    [{ name: "schema", value: { stringValue: schema } }]
  );

  if (!result.records?.length) return null;

  const row = result.records[0];
  return {
    schema_name: row[0].stringValue!,
    lambda_function_name: row[1].stringValue!,
    last_deployed_at: row[2].stringValue ?? "",
  };
}

// ---------------------------------------------------------------------------
// invokeAppLambda — for test-backend tool
// ---------------------------------------------------------------------------

export async function invokeAppLambda(
  schema: string,
  payload: Record<string, unknown>
): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
  const { InvokeCommand } = await import("@aws-sdk/client-lambda");

  const status = await getAppBackendStatus(schema);
  if (!status) {
    throw new Error(`No backend deployed for schema '${schema}'`);
  }

  const result = await lambdaClient().send(
    new InvokeCommand({
      FunctionName: status.lambda_function_name,
      InvocationType: "RequestResponse",
      Payload: Buffer.from(JSON.stringify(payload)),
    })
  );

  if (result.FunctionError) {
    const errorPayload = result.Payload
      ? JSON.parse(Buffer.from(result.Payload).toString())
      : { errorMessage: result.FunctionError };
    throw new Error(
      `Lambda error: ${errorPayload.errorMessage ?? result.FunctionError}`
    );
  }

  const response = result.Payload
    ? JSON.parse(Buffer.from(result.Payload).toString())
    : { statusCode: 502, body: "No response from Lambda" };

  return {
    statusCode: response.statusCode ?? 200,
    headers: response.headers ?? {},
    body: typeof response.body === "string" ? response.body : JSON.stringify(response.body ?? ""),
  };
}
