import {
  CognitoIdentityProviderClient,
  CreateUserPoolCommand,
  CreateUserPoolClientCommand,
  DeleteUserPoolCommand,
  DeleteUserPoolClientCommand,
  AdminCreateUserCommand,
  ListUsersCommand,
  UpdateUserPoolCommand,
  UsernameExistsException,
  type LambdaConfigType,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  LambdaClient,
  AddPermissionCommand,
  RemovePermissionCommand,
} from "@aws-sdk/client-lambda";
import {
  ApiGatewayV2Client,
  CreateRouteCommand,
  DeleteRouteCommand,
  GetRoutesCommand,
} from "@aws-sdk/client-apigatewayv2";
import {
  Route53Client,
  ChangeResourceRecordSetsCommand,
  type Change,
} from "@aws-sdk/client-route-53";
import { sql } from "./db.js";
import { getParameter, putParameter, deleteParameter } from "./ssm.js";
import {
  createServer as postmarkCreateServer,
  deleteServer as postmarkDeleteServer,
  findServerByName,
  renameServer as postmarkRenameServer,
  ensureBroadcastStream as postmarkEnsureBroadcastStream,
  createDomain as postmarkCreateDomain,
  deleteDomain as postmarkDeleteDomain,
  findDomainByName,
  getDomain as postmarkGetDomain,
} from "./postmark.js";
import { ensureCustomDomainsTable } from "./custom-domain.js";

// ---------------------------------------------------------------------------
// Config from environment
// ---------------------------------------------------------------------------

const region = () => process.env.awsRegion!;
const accountId = () => process.env.AWS_ACCOUNT_ID!;
const organizationId = () => process.env.ORGANIZATION_ID!;
const customDomain = () => process.env.customDomain!;
const hostedZoneId = () => process.env.HOSTED_ZONE_ID!;
const httpApiId = () => process.env.HTTP_API_ID!;
const authIntegrationId = () => process.env.AUTH_INTEGRATION_ID!;

const authRouteKey = (schema: string) => `ANY /${schema}/auth/{proxy+}`;

// Fixed order: PreSignUp, DefineAuthChallenge, CreateAuthChallenge, VerifyAuthChallengeResponse.
// Registry exposes the 4 trigger Lambda ARNs comma-separated in this order.
function triggerArns(): {
  preSignUp: string;
  defineChallenge: string;
  createChallenge: string;
  verifyChallenge: string;
} {
  const raw = process.env.COGNITO_TRIGGER_LAMBDA_ARNS;
  if (!raw) {
    throw new Error(
      "COGNITO_TRIGGER_LAMBDA_ARNS missing — the aws-mcp-app-lambda registry package must export this env var."
    );
  }
  const parts = raw.split(",").map((s) => s.trim());
  if (parts.length !== 4) {
    throw new Error(
      `COGNITO_TRIGGER_LAMBDA_ARNS must contain exactly 4 ARNs (got ${parts.length}).`
    );
  }
  return {
    preSignUp: parts[0],
    defineChallenge: parts[1],
    createChallenge: parts[2],
    verifyChallenge: parts[3],
  };
}

// Resource naming — hardcoded, not agent-configurable.
// The human-readable org label is the leftmost DNS label of the custom
// domain (e.g. "novopattern" from "novopattern.hereyalab.dev"). Using it
// instead of the UUID keeps Cognito and Postmark dashboards readable while
// staying globally unique (every org has a distinct customDomain).
const orgName = () => customDomain().split(".")[0];

// DNS labels can't contain underscores per RFC 1035, and Postmark rejects
// domains with underscores on POST /domains. Schemas like `terroir_direct`
// are valid Postgres identifiers but invalid DNS labels — map `_` -> `-`
// when building the sender domain. Cognito and Postmark server names accept
// underscores, so we keep them as-is for readability in those dashboards.
const dnsLabel = (schema: string) => schema.replace(/_/g, "-");

const poolName = (schema: string) => `${orgName()}-${schema}`;
const clientName = (schema: string) => `${orgName()}-${schema}-client`;
const serverName = (schema: string) => `${orgName()}-${schema}`;
const domainName = (schema: string) => `${dnsLabel(schema)}.${customDomain()}`;
const fromEmail = (schema: string) => `noreply@${domainName(schema)}`;

const postmarkServerTokenSsmPath = (schema: string) =>
  `/hereya/${organizationId()}/apps/${schema}/auth/postmark-server-token`;

// Lazy clients
let _cognito: CognitoIdentityProviderClient | undefined;
let _lambda: LambdaClient | undefined;
let _r53: Route53Client | undefined;
let _apigw: ApiGatewayV2Client | undefined;

function cognito(): CognitoIdentityProviderClient {
  if (!_cognito)
    _cognito = new CognitoIdentityProviderClient({ region: region() });
  return _cognito;
}
function lambda(): LambdaClient {
  if (!_lambda) _lambda = new LambdaClient({ region: region() });
  return _lambda;
}
function r53(): Route53Client {
  if (!_r53) _r53 = new Route53Client({});
  return _r53;
}
function apigw(): ApiGatewayV2Client {
  if (!_apigw) _apigw = new ApiGatewayV2Client({ region: region() });
  return _apigw;
}

// ---------------------------------------------------------------------------
// Auth API Gateway route — ensure idempotently (handles the case where
// deploy-backend already created it, or where enable-auth was called alone
// without any backend deployed).
// ---------------------------------------------------------------------------

async function findAuthRouteId(schema: string): Promise<string | undefined> {
  const target = authRouteKey(schema);
  let nextToken: string | undefined = undefined;
  do {
    const page: {
      Items?: Array<{ RouteId?: string; RouteKey?: string }>;
      NextToken?: string;
    } = await apigw().send(
      new GetRoutesCommand({ ApiId: httpApiId(), NextToken: nextToken })
    );
    for (const r of page.Items ?? []) {
      if (r.RouteKey === target && r.RouteId) return r.RouteId;
    }
    nextToken = page.NextToken;
  } while (nextToken);
  return undefined;
}

export async function ensureAuthRoute(schema: string): Promise<string> {
  try {
    const created = await apigw().send(
      new CreateRouteCommand({
        ApiId: httpApiId(),
        RouteKey: authRouteKey(schema),
        Target: `integrations/${authIntegrationId()}`,
      })
    );
    if (!created.RouteId) throw new Error("API Gateway returned no RouteId");
    return created.RouteId;
  } catch (err: unknown) {
    // If the route already exists (e.g. deploy-backend ran first), look it up.
    if ((err as { name?: string })?.name === "ConflictException") {
      const existing = await findAuthRouteId(schema);
      if (existing) return existing;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// DB table for tracking per-app auth resources
// ---------------------------------------------------------------------------

let tableReady = false;

async function ensureTable(): Promise<void> {
  if (tableReady) return;
  await sql(`
    CREATE TABLE IF NOT EXISTS public._app_auth (
      schema_name VARCHAR(255) PRIMARY KEY,
      user_pool_id VARCHAR(255) NOT NULL,
      user_pool_client_id VARCHAR(255) NOT NULL,
      postmark_server_id INTEGER NOT NULL,
      postmark_domain_id INTEGER NOT NULL,
      from_email VARCHAR(255) NOT NULL,
      auth_route_id VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  // Backfill for rows created before auth_route_id existed. Safe to run every
  // cold start — no-op if the column is already there.
  await sql(
    `ALTER TABLE public._app_auth ADD COLUMN IF NOT EXISTS auth_route_id VARCHAR(255)`
  );
  tableReady = true;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AppAuthStatus {
  schema_name: string;
  user_pool_id: string;
  user_pool_client_id: string;
  postmark_server_id: number;
  postmark_domain_id: number;
  from_email: string;
}

export interface EnableAuthResult extends AppAuthStatus {
  created: boolean;
}

// ---------------------------------------------------------------------------
// Status lookup (used by buildAppEnv to decide per-app vs shared pool)
// ---------------------------------------------------------------------------

export async function getAppAuthStatus(
  schema: string
): Promise<AppAuthStatus | null> {
  await ensureTable();
  const result = await sql(
    `SELECT schema_name, user_pool_id, user_pool_client_id,
            postmark_server_id, postmark_domain_id, from_email
     FROM public._app_auth WHERE schema_name = :schema`,
    [{ name: "schema", value: { stringValue: schema } }]
  );
  if (!result.records?.length) return null;
  const r = result.records[0];
  return {
    schema_name: r[0].stringValue!,
    user_pool_id: r[1].stringValue!,
    user_pool_client_id: r[2].stringValue!,
    postmark_server_id: Number(r[3].longValue ?? r[3].stringValue),
    postmark_domain_id: Number(r[4].longValue ?? r[4].stringValue),
    from_email: r[5].stringValue!,
  };
}

// ---------------------------------------------------------------------------
// createAppAuth — provision Cognito pool + Postmark server + DNS on demand
// ---------------------------------------------------------------------------

export async function createAppAuth(schema: string): Promise<EnableAuthResult> {
  await ensureTable();

  // Idempotent: if a row already exists, return it. But first correct any
  // drift in resources that may have been created before a policy change:
  //  - missing API Gateway auth route
  //  - pool-level settings (e.g. AllowAdminCreateUserOnly) that we now
  //    require to match the latest createAppAuth policy
  const existing = await getAppAuthStatus(schema);
  if (existing) {
    const routeRow = await sql(
      `SELECT auth_route_id FROM public._app_auth WHERE schema_name = :schema`,
      [{ name: "schema", value: { stringValue: schema } }]
    );
    const currentRouteId = routeRow.records?.[0]?.[0]?.stringValue;
    if (!currentRouteId) {
      const newRouteId = await ensureAuthRoute(schema);
      await sql(
        `UPDATE public._app_auth SET auth_route_id = :rid WHERE schema_name = :schema`,
        [
          { name: "rid", value: { stringValue: newRouteId } },
          { name: "schema", value: { stringValue: schema } },
        ]
      );
    }

    // Force admin-only onto existing pools and rename to the new
    // orgName-based convention. UpdateUserPool is destructive — fields we
    // omit get reset to defaults — so we have to re-send every pool-level
    // setting we originally configured in CreateUserPool (LambdaConfig,
    // Policies, AutoVerifiedAttributes). If we don't, Cognito strips the
    // Lambda triggers and sign-in breaks.
    const triggers = triggerArns();
    await cognito()
      .send(
        new UpdateUserPoolCommand({
          UserPoolId: existing.user_pool_id,
          PoolName: poolName(schema),
          AutoVerifiedAttributes: ["email"],
          AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
          LambdaConfig: {
            PreSignUp: triggers.preSignUp,
            DefineAuthChallenge: triggers.defineChallenge,
            CreateAuthChallenge: triggers.createChallenge,
            VerifyAuthChallengeResponse: triggers.verifyChallenge,
          },
          Policies: {
            PasswordPolicy: {
              MinimumLength: 8,
              RequireUppercase: false,
              RequireLowercase: false,
              RequireNumbers: false,
              RequireSymbols: false,
            },
          },
          UserPoolTags: {
            HereyaOrg: organizationId(),
            HereyaApp: schema,
          },
        })
      )
      .catch(() => undefined);

    // Postmark server: rename to orgName-based convention and ensure the
    // broadcast message stream exists. Both are idempotent.
    await postmarkRenameServer(existing.postmark_server_id, serverName(schema))
      .catch(() => undefined);
    const serverTokenForDrift = await getParameter(
      postmarkServerTokenSsmPath(schema)
    );
    if (serverTokenForDrift) {
      await postmarkEnsureBroadcastStream(serverTokenForDrift).catch(
        () => undefined
      );
    }

    // Custom-domain email backfill: for every _custom_domains row owned by
    // this schema that's still flagged pending_enable_auth, create a
    // Postmark sender signature now and flip to pending_verification. This
    // makes set-custom-domains -> enable-auth (in either order) converge.
    try {
      await ensureCustomDomainsTable();
      const pending = await sql(
        `SELECT domain FROM public._custom_domains
          WHERE schema_name = :schema AND email_status = 'pending_enable_auth'`,
        [{ name: "schema", value: { stringValue: schema } }]
      );
      for (const row of pending.records ?? []) {
        const domain = row[0].stringValue;
        if (!domain) continue;
        try {
          const pm = await postmarkCreateDomain(domain).catch(
            async (err: unknown) => {
              const status = (err as { status?: number })?.status;
              if (status === 422 || status === 409) {
                const existingDomain = await findDomainByName(domain);
                if (existingDomain) return existingDomain;
              }
              throw err;
            }
          );
          await sql(
            `UPDATE public._custom_domains
                SET postmark_domain_id = :id,
                    email_status = 'pending_verification',
                    updated_at = NOW()
              WHERE schema_name = :schema AND domain = :domain`,
            [
              { name: "id", value: { longValue: pm.ID } },
              { name: "schema", value: { stringValue: schema } },
              { name: "domain", value: { stringValue: domain } },
            ]
          );
        } catch (err) {
          console.error(
            `[enable-auth backfill] Postmark signature create failed for ${domain}:`,
            err
          );
        }
      }
    } catch (err) {
      console.error(
        `[enable-auth backfill] custom-domain backfill query failed:`,
        err
      );
    }

    return { ...existing, created: false };
  }

  const triggers = triggerArns();
  const lambdaConfig: LambdaConfigType = {
    PreSignUp: triggers.preSignUp,
    DefineAuthChallenge: triggers.defineChallenge,
    CreateAuthChallenge: triggers.createChallenge,
    VerifyAuthChallengeResponse: triggers.verifyChallenge,
  };

  // 1. Cognito user pool
  const pool = await cognito().send(
    new CreateUserPoolCommand({
      PoolName: poolName(schema),
      AutoVerifiedAttributes: ["email"],
      UsernameAttributes: ["email"],
      MfaConfiguration: "OFF",
      Schema: [
        {
          Name: "email",
          AttributeDataType: "String",
          Required: true,
          Mutable: true,
        },
      ],
      Policies: {
        PasswordPolicy: {
          MinimumLength: 8,
          RequireUppercase: false,
          RequireLowercase: false,
          RequireNumbers: false,
          RequireSymbols: false,
        },
      },
      // Lock down: only AdminCreateUser is allowed. The public SignUp API is
      // disabled at the pool level. Users can only be registered by the org
      // Lambda (add-user tool) or by a per-app Lambda that opts in via the
      // hereya runtime's users.createUser helper.
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
      LambdaConfig: lambdaConfig,
      UserPoolTags: {
        HereyaOrg: organizationId(),
        HereyaApp: schema,
      },
    })
  );

  const userPoolId = pool.UserPool?.Id;
  const userPoolArn = pool.UserPool?.Arn;
  if (!userPoolId || !userPoolArn) {
    throw new Error("Cognito did not return a user pool id/arn");
  }

  try {
    // 2. User pool client (public client, no secret — used by browser + auth Lambda)
    const client = await cognito().send(
      new CreateUserPoolClientCommand({
        UserPoolId: userPoolId,
        ClientName: clientName(schema),
        GenerateSecret: false,
        ExplicitAuthFlows: ["ALLOW_CUSTOM_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
        PreventUserExistenceErrors: "ENABLED",
      })
    );
    const userPoolClientId = client.UserPoolClient?.ClientId;
    if (!userPoolClientId) {
      throw new Error("Cognito did not return a user pool client id");
    }

    // 3. Grant each trigger Lambda invoke permission for this new pool.
    //    StatementId MUST include the pool id (not just schema), because a
    //    failed-then-retried enable-auth creates a new pool with a new ARN
    //    and we don't want the stale statement from the aborted attempt to
    //    block the new grant via ResourceConflictException. Pool ids are
    //    unique per creation, so pool-scoped statement ids are safe to
    //    leave behind (they're cleaned up by deleteAppAuth on drop-schema).
    const poolIdLabel = userPoolId.replace(/[^A-Za-z0-9-]/g, "-");
    const triggerList: Array<[string, string]> = [
      ["PreSignUp", triggers.preSignUp],
      ["DefineChallenge", triggers.defineChallenge],
      ["CreateChallenge", triggers.createChallenge],
      ["VerifyChallenge", triggers.verifyChallenge],
    ];
    for (const [tag, arn] of triggerList) {
      await lambda().send(
        new AddPermissionCommand({
          FunctionName: arn,
          StatementId: `Cognito-${poolIdLabel}-${tag}`,
          Action: "lambda:InvokeFunction",
          Principal: "cognito-idp.amazonaws.com",
          SourceArn: userPoolArn,
        })
      ).catch((err: unknown) => {
        if ((err as { name?: string })?.name !== "ResourceConflictException") {
          throw err;
        }
      });
    }

    // 4. Postmark server — tolerate name collision by reusing the existing one
    let server = await postmarkCreateServer(serverName(schema)).catch(
      async (err: unknown) => {
        const status = (err as { status?: number })?.status;
        if (status === 422 || status === 409) {
          const existingServer = await findServerByName(serverName(schema));
          if (existingServer) return existingServer;
        }
        throw err;
      }
    );

    // 4b. Provision the broadcast stream alongside the default outbound
    // stream so mail.send({ stream: "broadcast" }) works without manual
    // Postmark dashboard setup.
    const serverToken = server.ApiTokens?.[0];
    if (serverToken) {
      await postmarkEnsureBroadcastStream(serverToken).catch(() => undefined);
    }

    try {
      // 5. Postmark sender domain — reuse if it already exists
      let domain = await postmarkCreateDomain(domainName(schema)).catch(
        async (err: unknown) => {
          const status = (err as { status?: number })?.status;
          if (status === 422 || status === 409) {
            const existingDomain = await findDomainByName(domainName(schema));
            if (existingDomain) return existingDomain;
          }
          throw err;
        }
      );

      try {
        // 6. Route53 DKIM TXT + return-path CNAME
        const changes: Change[] = [
          {
            Action: "UPSERT",
            ResourceRecordSet: {
              Name: domain.DKIMPendingHost,
              Type: "TXT",
              TTL: 300,
              ResourceRecords: [{ Value: `"${domain.DKIMPendingTextValue}"` }],
            },
          },
          {
            Action: "UPSERT",
            ResourceRecordSet: {
              Name: domain.ReturnPathDomain,
              Type: "CNAME",
              TTL: 300,
              ResourceRecords: [{ Value: domain.ReturnPathDomainCNAMEValue }],
            },
          },
        ];
        await r53().send(
          new ChangeResourceRecordSetsCommand({
            HostedZoneId: hostedZoneId(),
            ChangeBatch: { Changes: changes },
          })
        );

        // 7. Store per-app Postmark server token in SSM SecureString
        await putParameter(
          postmarkServerTokenSsmPath(schema),
          server.ApiTokens?.[0] ?? "",
          { overwrite: true }
        );

        // 8. API Gateway auth route — idempotent; tolerates deploy-backend
        //    having created it first.
        const authRouteId = await ensureAuthRoute(schema);

        // 9. Persist row
        await sql(
          `INSERT INTO public._app_auth (schema_name, user_pool_id, user_pool_client_id,
             postmark_server_id, postmark_domain_id, from_email, auth_route_id)
           VALUES (:schema, :pool, :client, :server, :domain, :email, :route)
           ON CONFLICT (schema_name) DO NOTHING`,
          [
            { name: "schema", value: { stringValue: schema } },
            { name: "pool", value: { stringValue: userPoolId } },
            { name: "client", value: { stringValue: userPoolClientId } },
            { name: "server", value: { longValue: server.ID } },
            { name: "domain", value: { longValue: domain.ID } },
            { name: "email", value: { stringValue: fromEmail(schema) } },
            { name: "route", value: { stringValue: authRouteId } },
          ]
        );

        return {
          schema_name: schema,
          user_pool_id: userPoolId,
          user_pool_client_id: userPoolClientId,
          postmark_server_id: server.ID,
          postmark_domain_id: domain.ID,
          from_email: fromEmail(schema),
          created: true,
        };
      } catch (err) {
        // Unwind domain
        await postmarkDeleteDomain(domain.ID).catch(() => undefined);
        throw err;
      }
    } catch (err) {
      // Unwind server
      await postmarkDeleteServer(server.ID).catch(() => undefined);
      throw err;
    }
  } catch (err) {
    // Unwind Cognito pool (client is deleted with the pool)
    await cognito()
      .send(new DeleteUserPoolCommand({ UserPoolId: userPoolId }))
      .catch(() => undefined);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// deleteAppAuth — best-effort teardown
// ---------------------------------------------------------------------------

export async function deleteAppAuth(schema: string): Promise<void> {
  await ensureTable();

  const existing = await getAppAuthStatus(schema);
  if (!existing) return;

  const triggers = triggerArns();
  const triggerList: Array<[string, string]> = [
    ["PreSignUp", triggers.preSignUp],
    ["DefineChallenge", triggers.defineChallenge],
    ["CreateChallenge", triggers.createChallenge],
    ["VerifyChallenge", triggers.verifyChallenge],
  ];

  // Route53 — delete DKIM and return-path records. We read current values from
  // Postmark so we don't try to delete a record with the wrong RDATA.
  try {
    const domain = await postmarkGetDomain(existing.postmark_domain_id);
    const changes: Change[] = [
      {
        Action: "DELETE",
        ResourceRecordSet: {
          Name: domain.DKIMPendingHost,
          Type: "TXT",
          TTL: 300,
          ResourceRecords: [{ Value: `"${domain.DKIMPendingTextValue}"` }],
        },
      },
      {
        Action: "DELETE",
        ResourceRecordSet: {
          Name: domain.ReturnPathDomain,
          Type: "CNAME",
          TTL: 300,
          ResourceRecords: [{ Value: domain.ReturnPathDomainCNAMEValue }],
        },
      },
    ];
    await r53()
      .send(
        new ChangeResourceRecordSetsCommand({
          HostedZoneId: hostedZoneId(),
          ChangeBatch: { Changes: changes },
        })
      )
      .catch(() => undefined);
  } catch {
    // Domain may already be gone — leave orphan records for manual cleanup;
    // safer than guessing RDATA and deleting the wrong record.
  }

  // Postmark domain + server
  await postmarkDeleteDomain(existing.postmark_domain_id).catch(() => undefined);
  await postmarkDeleteServer(existing.postmark_server_id).catch(() => undefined);

  // Remove Cognito trigger invoke permissions (idempotent).
  // Try both the new pool-id-scoped statement id and the legacy schema-
  // scoped one so rows created before the statement-id format change also
  // clean up cleanly.
  const poolIdLabel = existing.user_pool_id.replace(/[^A-Za-z0-9-]/g, "-");
  for (const [tag, arn] of triggerList) {
    for (const stmtId of [
      `Cognito-${poolIdLabel}-${tag}`,
      `Cognito-${schema}-${tag}`,
    ]) {
      await lambda()
        .send(
          new RemovePermissionCommand({
            FunctionName: arn,
            StatementId: stmtId,
          })
        )
        .catch(() => undefined);
    }
  }

  // Cognito client + pool
  await cognito()
    .send(
      new DeleteUserPoolClientCommand({
        UserPoolId: existing.user_pool_id,
        ClientId: existing.user_pool_client_id,
      })
    )
    .catch(() => undefined);
  await cognito()
    .send(new DeleteUserPoolCommand({ UserPoolId: existing.user_pool_id }))
    .catch(() => undefined);

  // SSM token
  await deleteParameter(postmarkServerTokenSsmPath(schema)).catch(() => undefined);

  // API Gateway auth route — if we tracked one, delete it. (For apps that
  // also ran deploy-backend, the route may be tracked in _app_backends as
  // well; deleteAppBackend handles that and a stale route_id here is
  // harmless because we best-effort-delete.)
  const routeRow = await sql(
    `SELECT auth_route_id FROM public._app_auth WHERE schema_name = :schema`,
    [{ name: "schema", value: { stringValue: schema } }]
  );
  const routeId = routeRow.records?.[0]?.[0]?.stringValue;
  if (routeId) {
    await apigw()
      .send(new DeleteRouteCommand({ ApiId: httpApiId(), RouteId: routeId }))
      .catch(() => undefined);
  }

  // DB row
  await sql(`DELETE FROM public._app_auth WHERE schema_name = :schema`, [
    { name: "schema", value: { stringValue: schema } },
  ]);

  // Reset custom-domain email signatures: the per-app Postmark server has
  // been deleted, so every signature hosted on it is gone too. Null the
  // postmark_domain_id and flip email_status back to pending_enable_auth
  // so a future enable-auth idempotency backfill recreates the signatures
  // against the fresh server.
  try {
    await ensureCustomDomainsTable();
    await sql(
      `UPDATE public._custom_domains
          SET postmark_domain_id = NULL,
              email_status = 'pending_enable_auth',
              updated_at = NOW()
        WHERE schema_name = :schema AND email_status <> 'removed'`,
      [{ name: "schema", value: { stringValue: schema } }]
    );
  } catch {
    // best-effort — table may not exist yet on orgs that never used it
  }
}

// ---------------------------------------------------------------------------
// migrateSharedPoolUsers — bulk-copy shared-pool users into the per-app pool
// ---------------------------------------------------------------------------

export interface MigrateResult {
  copied: number;
  skipped_existing: number;
  failed: string[];
}

export async function migrateSharedPoolUsers(
  schema: string
): Promise<MigrateResult> {
  const app = await getAppAuthStatus(schema);
  if (!app) {
    throw new Error(
      `enable-auth has not been called for '${schema}'. Nothing to migrate into.`
    );
  }

  const sharedPoolId = process.env.userPoolId ?? process.env.COGNITO_USER_POOL_ID;
  if (!sharedPoolId) {
    throw new Error(
      "Shared Cognito pool id not found in env — nothing to migrate from."
    );
  }

  let copied = 0;
  let skipped_existing = 0;
  const failed: string[] = [];

  let paginationToken: string | undefined = undefined;
  do {
    const page: {
      Users?: Array<{ Attributes?: Array<{ Name?: string; Value?: string }> }>;
      PaginationToken?: string;
    } = await cognito().send(
      new ListUsersCommand({
        UserPoolId: sharedPoolId,
        Limit: 60,
        PaginationToken: paginationToken,
      })
    );

    for (const u of page.Users ?? []) {
      const email = u.Attributes?.find((a) => a.Name === "email")?.Value;
      if (!email) continue;
      try {
        await cognito().send(
          new AdminCreateUserCommand({
            UserPoolId: app.user_pool_id,
            Username: email,
            MessageAction: "SUPPRESS",
            UserAttributes: [
              { Name: "email", Value: email },
              { Name: "email_verified", Value: "true" },
            ],
          })
        );
        copied++;
      } catch (err: unknown) {
        if (err instanceof UsernameExistsException) {
          skipped_existing++;
        } else {
          failed.push(email);
        }
      }
    }

    paginationToken = page.PaginationToken;
  } while (paginationToken);

  return { copied, skipped_existing, failed };
}

// ---------------------------------------------------------------------------
// Convenience for per-app Lambda env injection — used by src/app-lambda.ts
// ---------------------------------------------------------------------------

export function accountIdFromEnv(): string {
  return accountId();
}
