# hereya/ai-app

A **hereya-app** that hosts an AI-agent storage backend MCP server: per-org Postgres schema, S3 folders, skills (stored instructions), MCP views, and per-app backend Lambda deployment for web frontends.

This is a clone of [`hereya/apps`](https://github.com/hereya/hereya-apps) repackaged as a `kind: app` registry artefact, so it can be published once and deployed to any Hereya workspace via `hereya app deploy`. Same MCP tool surface, same runtime; the only difference is how it gets onto a workspace.

## What you get per deployment

| Resource | Provided by |
| --- | --- |
| Aurora Postgres serverless cluster (org-scoped data API) | `hereya/aws-postgres-serverless` |
| S3 bucket with org-prefixed access | `hereya/aws-file-storage` |
| Cognito user pool (per-app frontend auth) | `aws/cognito` |
| Postmark transactional email | `hereya/postmark-client` + `hereya/postmark-account-credentials` |
| Lambda + API Gateway + CloudFront + custom domain + OAuth authorizer | `hereya/aws-mcp-app-lambda` |

The Lambda runs the bundled MCP server and exposes 24 primitives across schema, data, files, instructions, skills, views, deploy, config, auth, mail, users, and custom-domain.

## Parameters

| Parameter | Mandatory | Default | Description |
| --- | --- | --- | --- |
| `customDomain` | yes | — | DNS hostname that fronts the deployed MCP (e.g. `ai-app-dev.hereyalab.dev`). The package wires CloudFront + ACM + Route53 against this. |
| `organizationId` | yes | — | UUID of the Hereya org that owns this deployment. Bounds OAuth + per-org isolation. |
| `oauthServerUrl` | no | `https://cloud.hereya.dev` | Hereya Cloud URL the MCP authenticates against. Override only for non-prod clouds. |
| `lambdaTimeout` | no | `900` | Lambda execution timeout in seconds. AWS max is 900. |

## Deploy

```bash
hereya app deploy hereya/ai-app \
  -w hereya/<your-workspace> \
  -p customDomain=<your-subdomain>.hereyalab.dev \
  -p organizationId=<your-org-uuid>
```

The first deploy provisions everything from scratch and may take 5–10 minutes (CloudFront + ACM dominate). Re-running with the same parameters is idempotent. To tear down:

```bash
hereya app destroy hereya/ai-app -w hereya/<your-workspace>
```

After deploy, register the MCP in Claude Desktop using `https://<customDomain>/mcp` and OAuth through Hereya. On updates, disconnect and reconnect.

## Develop

This is a TypeScript + esbuild + Vite project. Local checks:

```bash
npm install
npm run build      # bundles handler + runtime layer + view shell
npm run typecheck  # tsc --noEmit
```

The build also runs on the executor at deploy time via `preDeployCommand`; you don't need to commit `dist/`.

To iterate on changes, see the **Local dev** section in [`CLAUDE.md`](./CLAUDE.md).

## Publish a new version

1. Bump `version:` in [`hereyarc.yaml`](./hereyarc.yaml).
2. Commit the source changes and push to `main`.
3. From inside the repo:
   ```bash
   hereya publish
   ```
4. Existing deployments stay on their pinned version until you re-deploy them with `--version <new>`.

## Layout

```
hereyarc.yaml          # registry metadata (kind: app, parameters)
hereya.yaml            # packages + deploy package + preDeployCommand
hereyaconfig/
  hereyavars/          # placeholder values for package inputs (uses {{name}})
src/
  handler.ts           # Lambda entry — MCP requests
  server.ts            # MCP server factory + tool registration
  tools/               # 24 MCP primitives
  runtime/             # Lambda Layer for per-app Lambdas
  shell/               # HTML shell for views (Vite-bundled)
package.json           # scripts, esbuild, vite
```

For the in-depth architecture walkthrough (request flow, env vars, primitive list, skills/views storage model), see [`CLAUDE.md`](./CLAUDE.md).
