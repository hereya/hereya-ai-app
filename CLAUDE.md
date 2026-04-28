# Hereya AI app (hereya/ai-app)

Clone of `hereya/apps` packaged as a **hereya-app** (`kind: app` in `hereyarc.yaml`). Same MCP tool surface — schema, data, files, instructions, skills, views, config, deploy primitives — but published as a registry artefact and deployed to workspaces via `hereya app deploy`.

Hereya does not contain business logic, UI, or domain knowledge. The AI agent handles all of that. Hereya provides the persistent storage layer — database, files, skills, and views — plus per-app Lambda deployment for web frontends.

**An "app" on Hereya = a Postgres schema + an S3 folder + skills (stored instructions) + views (MCP views) + a per-app backend Lambda (for web frontend).** Hereya manages all of these.

## Deployment

This is a **hereya-app** registry artefact. The build (`npm install && npm run build`) runs on the executor at deploy time via `preDeployCommand`; you do **not** need to build locally before publishing.

### One-time per release: publish

Bump `version:` in `hereyarc.yaml`, commit, push (the executor downloads at the published commit — uncommitted code never reaches the executor). Then:

```bash
hereya publish
```

This registers a new immutable `hereya/ai-app@<version>` in the registry.

### Per workspace: deploy

```bash
hereya app deploy hereya/ai-app -w hereya/hereya-dev
```

Per-workspace overrides (custom domain, organization id) come from the bundled `hereyaconfig/hereyavars/hereya--aws-mcp-app-lambda.yaml`, picked by workspace name. To deploy to a workspace not in that file, add a profile block and republish, or pass per-deploy overrides:

```bash
hereya app deploy hereya/ai-app -w hereya/some-org --vars-file ./overrides.yaml
```

where `overrides.yaml` is e.g.

```yaml
hereya--aws-mcp-app-lambda.yaml: |
  ---
  profile: some-org
  customDomain: ai-app-some-org.hereyalab.dev
  organizationId: <org-uuid>
  oauthServerUrl: https://cloud.hereya.dev
  timeout: "900"
```

After deployment, register the MCP server in Claude Desktop using `https://<customDomain>/mcp`, then OAuth through Hereya. On updates, disconnect and reconnect.

### Local dev / testing changes before publishing

Because this is `kind: app`, `hereya.yaml` does NOT carry `project:` / `workspace:` and the in-tree `hereya deploy` flow is unavailable. Two options:

- **Recommended**: publish a `0.x.y-dev.<n>` version and `hereya app deploy hereya/ai-app -w hereya/hereya-dev` to exercise it. Each iteration is a fresh publish + deploy cycle.
- For tight loops you can keep a gitignored `hereya.yaml.local` (with `project: hereya/ai-app` + `workspace: hereya-dev` added back) and temporarily copy it over `hereya.yaml` to use the older `hereya deploy -w …` flow. Don't commit it.

## Quick commands

```bash
npm run build        # Bundle handler + runtime layer (esbuild)
npm run build:layer  # Bundle runtime layer only
npm run build:handler # Bundle handler only
npm run typecheck    # TypeScript type checking (no emit)
```

## Architecture

### Request flow

```
MCP requests:
  Client -> API Gateway -> MCP Authorizer (JWT/RS256) -> Org Lambda -> MCP SDK -> Tool
                              | (reject)
                       401 Unauthorized

Frontend requests (via CloudFront):
  Browser -> CloudFront -> CF Function (prepend app name) -> API Gateway
    /{app}/auth/*   -> Auth Lambda (no authorizer)
    /{app}/*        -> Frontend Authorizer -> Per-app Lambda (agent-written code)
```

The org Lambda handles only MCP requests (`POST /mcp`). Frontend requests are routed directly to per-app Lambdas by API Gateway (routes created dynamically by `deploy-backend`). MCP requests receive `userId`, `orgId`, `orgRole` from the MCP authorizer. Frontend requests receive `email`, `cognito_sub` from the Frontend authorizer (Cognito JWT cookie).

### Infrastructure packages

| Package | Version | Purpose |
|---------|---------|---------|
| `hereya/aws-mcp-app-lambda` | 0.1.3 | Lambda + API Gateway + custom domain + OAuth authorizer |
| `hereya/aws-postgres-serverless` | 0.1.6 | Aurora Serverless v2 with Data API (isolated DB per org) |
| `hereya/aws-file-storage` | 0.1.1 | Scoped S3 access (prefix-isolated per org) |

### Environment variables (injected by Hereya packages)

| Variable | Source | Description |
|----------|--------|-------------|
| `clusterArn` | aws-postgres-serverless | Aurora cluster ARN |
| `secretArn` | aws-postgres-serverless | DB credentials (Secrets Manager ARN via SSM) |
| `databaseName` | aws-postgres-serverless | PostgreSQL database name |
| `bucketName` | aws-file-storage | S3 bucket name |
| `s3Prefix` | aws-file-storage | Scoped S3 key prefix (org-isolated) |
| `awsRegion` | aws-mcp-app-lambda | AWS region |
| `OAUTH_SERVER_URL` | hereyaconfig | OAuth server URL |
| `BOUND_ORG_ID` | hereyaconfig | Organization ID for access control |
| `SECRET_KEYS` | aws-mcp-app-lambda | Comma-separated env var names to resolve from Secrets Manager |

## Source files

```
src/
├── handler.ts           # Lambda entry point — MCP requests only
├── server.ts            # MCP server factory — creates McpServer, registers tools
├── app-lambda.ts        # Per-app Lambda lifecycle — create, update, delete, invoke
├── secrets.ts           # Resolves SECRET_KEYS env vars from AWS Secrets Manager at startup
├── db.ts                # Aurora Data API wrapper — sql(), param conversion, safety guards, batch insert
├── storage.ts           # S3 operations — folders, presigned URLs, list, delete, getFileContent
├── errors.ts            # Shared toolError() helper for MCP error responses
├── schema-utils.ts      # Shared describeSchemaStructure() helper (used by describe-schema and get-skill)
├── runtime/             # Runtime layer for per-app Lambdas (bundled as Lambda Layer)
│   ├── index.ts         # Re-exports db, storage, parseRequest
│   ├── db.ts            # Aurora Data API wrapper for per-app Lambdas
│   ├── storage.ts       # S3 operations for per-app Lambdas
│   └── request.ts       # parseRequest() — API Gateway event to AppRequest
└── tools/
    ├── index.ts         # Tool registration — wires all modules
    ├── schema.ts        # 4 schema primitives (create, list, describe, drop)
    ├── data.ts          # 3 data primitives (execute, query, bulk-insert)
    ├── files.ts         # 5 file primitives (create-folder, upload, download, list, delete)
    ├── instructions.ts  # 1 instruction primitive (get-instructions)
    ├── skills.ts        # 4 skill primitives (save, get, list, delete)
    ├── views.ts         # 4 view primitives (save, get, list, delete)
    ├── deploy.ts        # 2 deploy primitives (deploy-backend, test-backend)
    └── config.ts        # 1 config primitive (enable-frontend)
```

## Primitives

### Schema primitives (4)

| # | Tool | Description |
|---|------|-------------|
| 1 | `create-schema` | Create a new app schema + S3 folder |
| 2 | `list-schemas` | List all app schemas (excludes system and internal schemas) |
| 3 | `describe-schema` | Full structure: tables, columns, types, constraints |
| 4 | `drop-schema` | Drop schema CASCADE + delete S3 folder + delete skills (requires `confirm: true`) |

### Data primitives (3)

| # | Tool | Description |
|---|------|-------------|
| 5 | `execute` | Any DDL/DML SQL with `:param_name` params. Rejects DROP SCHEMA/DATABASE |
| 6 | `query` | SELECT with `:param_name` params. Returns `{ columns, rows, row_count }`. Max 1000 rows |
| 7 | `bulk-insert` | Batch insert: schema, table, columns, rows. Auto-chunks at 500. Max 10,000 rows |

### File primitives (5)

| # | Tool | Description |
|---|------|-------------|
| 8 | `create-folder` | Create S3 folder under org's space |
| 9 | `get-upload-url` | Presigned PUT URL for direct upload |
| 10 | `get-download-url` | Presigned GET URL for direct download |
| 11 | `list-files` | List files and subfolders at a path |
| 12 | `delete-file` | Delete a file |

### Instruction primitive (1)

| # | Tool | Description |
|---|------|-------------|
| 13 | `get-instructions` | Static workflow guides. Topics: `create-app`, `use-app`, `update-app`, `write-skill`, `frontend` |

### Skill primitives (4)

| # | Tool | Description |
|---|------|-------------|
| 14 | `save-skill` | Save/update a skill for an app. Multiple skills per schema supported |
| 15 | `get-skill` | Get skill content + full schema structure in one call |
| 16 | `list-skills` | List all skills (optionally filter by schema). Returns metadata only |
| 17 | `delete-skill` | Delete a skill |

### View primitives (4)

| # | Tool | Description |
|---|------|-------------|
| 18 | `save-view` | Save/update a reusable HTML view with data queries. Templates use web components + Mustache |
| 19 | `get-view` | Render a saved view with fresh data (~100ms). Returns HTML as MCP App resource |
| 20 | `list-views` | List saved views for a schema |
| 21 | `delete-view` | Delete a saved view |

### Deploy primitives (2)

| # | Tool | Description |
|---|------|-------------|
| 22 | `deploy-backend` | Deploy/update a per-app backend Lambda from a zip on S3. Creates Lambda + API Gateway routes on first deploy |
| 23 | `test-backend` | Invoke a deployed per-app Lambda to test it. Sends a synthetic request, returns the response |

### Config primitive (1)

| # | Tool | Description |
|---|------|-------------|
| 24 | `enable-frontend` | Enable web frontend for an app schema. Instant — just a database flag |

## Frontend

Apps can graduate from "inside Claude" to web-accessible via per-app backend Lambdas.

### Domain structure

- `{org}.hereya.app` → MCP endpoint (Claude)
- `{app}.{org}.hereya.app` → per-app backend Lambda (browsers)

### Per-app backend Lambdas

Each app with a frontend gets its own Lambda function running agent-written Node.js code. The agent:
1. Writes a `handler.js` that exports a handler function
2. Creates a deployment zip and uploads it to S3
3. Calls `deploy-backend` to create/update the Lambda + API Gateway routes

The per-app Lambda has access to Aurora Data API and S3 via the `hereya` runtime layer. Auth is handled automatically by API Gateway (Cognito JWT cookie).

### API Gateway routing (dynamic)

Routes are created dynamically when `deploy-backend` is called:
- `ANY /{schema}` → per-app Lambda (with frontend authorizer)
- `ANY /{schema}/{proxy+}` → per-app Lambda (with frontend authorizer)
- `ANY /{schema}/auth/{proxy+}` → auth Lambda (no authorizer)

Route priority ensures auth routes take precedence over the catch-all.

### Runtime layer

The `hereya` module (Lambda Layer) provides:
- `parseRequest(event)` → `{ path, method, headers, query, body, auth, schema }`
- `sql(query, params?)` → execute any SQL
- `query(query, params?)` → execute SELECT, returns `{ columns, rows, row_count }`
- `convertParams(obj)` → convert params to Data API format
- `storage.*` → S3 operations (getFileContent, putFileContent, etc.)

### Per-app Lambda management

Tracked in `public._app_backends` table. The org Lambda manages per-app Lambdas via AWS SDK:
- Creates Lambda functions with naming convention `{orgPrefix}-app-{schema}`
- Creates API Gateway integrations and routes
- Cleans up on `drop-schema`

## Database

### Aurora Data API

All database access goes through the RDS Data API — no connection pools, no VPC, no pg drivers. The `sql()` helper in `src/db.ts` wraps `ExecuteStatement`:

```typescript
import { sql, convertParams } from "../db.js";

// Using convertParams for simple key-value params
const result = await sql(
  `SELECT * FROM recipes.recipes WHERE category = :cat`,
  convertParams({ cat: "desserts" })
);
```

### Parameter conversion

The `convertParams()` function converts simple `{ key: value }` objects to Data API format:

- `string` → `stringValue`
- integer `number` → `longValue`
- float `number` → `doubleValue`
- `boolean` → `booleanValue`
- `null`/`undefined` → `isNull: true`

### SQL safety

The `execute` tool rejects `DROP SCHEMA` and `DROP DATABASE` statements via regex check (`assertSafeSql()`). These must go through the `drop-schema` primitive which requires `confirm: true` and also cleans up S3.

### Identifier validation

`isValidIdentifier()` checks names match `/^[a-z_][a-z0-9_]{0,62}$/i`. `quoteIdent()` double-quotes identifiers as defense-in-depth. Used by schema tools and bulk-insert.

## S3 File Storage

Files are stored in S3 under a prefix scoped to this org. All paths are relative to the org prefix.

- `createFolder(path)` — zero-byte PutObject with trailing `/`
- `getUploadUrl(path, contentType?, expiresIn?)` — presigned PUT URL
- `getDownloadUrl(path, expiresIn?)` — presigned GET URL (checks file exists)
- `getFileContent(path)` — read file content as string (returns null if not found). Used by frontend for layout.html
- `listFiles(path?, recursive?)` — ListObjectsV2 with delimiter
- `deleteFile(path)` — DeleteObject (checks file exists)
- `deleteFolderRecursive(path)` — paginated list + batch delete

Path validation rejects `..`, `//`, and leading `/`.

## Error format

All tool errors use `toolError(code, message)` from `src/errors.ts`:

```json
{ "error": { "code": "SCHEMA_NOT_FOUND", "message": "Schema 'recipes' does not exist" } }
```

Error codes: `SCHEMA_EXISTS`, `SCHEMA_NOT_FOUND`, `TABLE_NOT_FOUND`, `INVALID_NAME`, `INVALID_PATH`, `FILE_NOT_FOUND`, `SKILL_NOT_FOUND`, `VIEW_NOT_FOUND`, `ENDPOINT_NOT_FOUND`, `ACTION_NOT_FOUND`, `RENDER_ERROR`, `INVALID_TOPIC`, `INVALID_BODY`, `CONFIRMATION_REQUIRED`, `FORBIDDEN_OPERATION`, `FRONTEND_NOT_ENABLED`, `SQL_ERROR`, `RESULT_TOO_LARGE`, `PAYLOAD_TOO_LARGE`.

## Instructions

The `get-instructions` tool returns static workflow guides hardcoded in `src/tools/instructions.ts`. Available topics:

- `create-app` — How to create a new app (schema + tables + skill)
- `use-app` — How to discover and use existing apps
- `update-app` — How to evolve an app (ALTER TABLE + update skill)
- `write-skill` — How to write effective skills (structure, examples, best practices)
- `frontend` — How to enable and build web frontends (views, data endpoints, actions, auth)

## Skills

Skills are per-app instruction documents stored in the `_hereya.skills` table. They tell agents what an app does and how to use it.

### Internal schema

The `_hereya` schema is created lazily on first skill operation. It contains:

```sql
_hereya.skills (
  id SERIAL PRIMARY KEY,
  schema_name VARCHAR(63) NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  content TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(schema_name, name)
)
```

Multiple skills per schema are supported (e.g., "main", "cost-analysis", "reporting").

The `_hereya` schema is excluded from `list-schemas` results.

### Skill lifecycle

1. Agent creates an app → `create-schema` + `execute` (CREATE TABLEs)
2. Agent writes a skill → `save-skill({ schema, name, content })`
3. Future agent discovers apps → `list-skills()`
4. Future agent loads skill → `get-skill({ schema, name })` → returns skill + schema structure
5. App evolves → `execute` (ALTER TABLE) → `save-skill` (update content)
6. App dropped → `drop-schema` automatically deletes all skills for that schema

## Views

Views are reusable HTML templates with embedded SQL queries, rendered server-side with Mustache. They support interactivity via web components and raw `postMessage` (no frameworks, no SDK import).

### Per-schema storage

Each schema stores its views in a `_views` table created lazily on first `save-view`:

```sql
{schema}._views (
  name VARCHAR(255) PRIMARY KEY,
  description TEXT,
  template TEXT NOT NULL,
  queries JSONB NOT NULL,
  public BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
)
```

Since `_views` lives inside the app schema, `DROP SCHEMA CASCADE` automatically cleans up all views — no separate cleanup needed.

### Rendering

`get-view` loads the template and queries, executes each query (substituting `:param_name` from params), builds a context object (0 rows → null, 1+ rows → array), and renders with `Mustache.render()`. The rendered HTML is returned as an embedded `resource` content item with MIME type `text/html;profile=mcp-app`.

### Error codes

`VIEW_NOT_FOUND`, `RENDER_ERROR` (in addition to shared codes like `SQL_ERROR`, `SCHEMA_NOT_FOUND`, `INVALID_NAME`).

## Auth context in tools

Tools receive auth info via the second parameter's `authInfo.extra`:

```typescript
async ({ input }, { authInfo }) => {
  const extra = authInfo?.extra as Record<string, unknown>;
  const userId = extra?.userId;
  const orgId = extra?.orgId;
  const orgRole = extra?.orgRole;
};
```

## Build

esbuild bundles `src/handler.ts` into `dist/handler.js` (CJS, Node 22, all deps included). `dist/handler.js` is deployed to Lambda via `hereya/aws-mcp-app-lambda`.

## Configuration

- `hereya.yaml` — infrastructure packages and versions
- `hereyaconfig/hereyavars/hereya--aws-mcp-app-lambda.yaml` — custom domain, OAuth URL, org ID (per profile)
- `hereyaconfig/hereyavars/hereya--aws-postgres-serverless.yaml` — auto-delete flag (per profile)
