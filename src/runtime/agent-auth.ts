import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { sql } from "./db.js";
import { getAgentSecret } from "./ssm.js";
import {
  type BootstrapPayload,
  type SessionPayload,
  SESSION_TTL_SECONDS,
  BOOTSTRAP_TTL_SECONDS,
  mintSessionToken,
  verifyToken,
} from "./token-signing.js";

// ---------------------------------------------------------------------------
// Agent-session auth for per-app Lambdas.
//
// Flow:
//   1. MCP server mints a 5-min bootstrap token signed with the per-app
//      secret (in SSM) and hands the agent a URL containing it.
//   2. Agent opens the URL in a browser. The per-app Lambda's handler calls
//      handleAgentBootstrap(event) at the top of the handler. On a valid
//      bootstrap token, the Lambda mints a 30-min session token, sets it as
//      an HttpOnly cookie, and 302-redirects to the redirect path.
//   3. Subsequent requests carry the session cookie. parseRequest() calls
//      verifySessionCookie() and promotes req.auth.authenticated = true when
//      the signature checks out.
//
// Security:
//   - HMAC-SHA256 over a canonical JSON payload using the per-app secret.
//   - Bootstrap tokens are single-use, enforced in the DB
//     (public._agent_bootstrap_jti). Replay fails atomically.
//   - Session cookie: HttpOnly, Secure, SameSite=Strict, 30-min Max-Age.
//   - Cognito auth always wins over agent auth when both are present
//     (parseRequest enforces this).
// ---------------------------------------------------------------------------

export const BOOTSTRAP_PATH = "/__hereya/agent-bootstrap";
export const SESSION_COOKIE = "hereya_agent";
export { BOOTSTRAP_TTL_SECONDS, SESSION_TTL_SECONDS };

// ---------------------------------------------------------------------------
// Single-use jti enforcement in DB
// ---------------------------------------------------------------------------

let jtiTableReady = false;

async function ensureJtiTable(): Promise<void> {
  if (jtiTableReady) return;
  await sql(`
    CREATE TABLE IF NOT EXISTS public._agent_bootstrap_jti (
      jti VARCHAR(64) PRIMARY KEY,
      used_at TIMESTAMP NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMP NOT NULL
    )
  `);
  jtiTableReady = true;
}

async function claimJti(jti: string, exp: number): Promise<boolean> {
  await ensureJtiTable();
  const expiresAt = new Date(exp * 1000).toISOString();
  const result = await sql(
    `INSERT INTO public._agent_bootstrap_jti (jti, expires_at)
     VALUES (:jti, :expires_at::timestamp)
     ON CONFLICT (jti) DO NOTHING`,
    [
      { name: "jti", value: { stringValue: jti } },
      { name: "expires_at", value: { stringValue: expiresAt } },
    ]
  );
  return (result.numberOfRecordsUpdated ?? 0) === 1;
}

async function sweepExpiredJtis(): Promise<void> {
  try {
    await sql(
      `DELETE FROM public._agent_bootstrap_jti WHERE expires_at < NOW()`
    );
  } catch {
    // Best effort — never break auth on sweep failure.
  }
}

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------

function buildSessionCookie(token: string): string {
  return [
    `${SESSION_COOKIE}=${token}`,
    `Max-Age=${SESSION_TTL_SECONDS}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
  ].join("; ");
}

function parseCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  const parts = header.split(";");
  for (const part of parts) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    if (trimmed.slice(0, eq) === name) {
      return trimmed.slice(eq + 1);
    }
  }
  return null;
}

export function readSessionCookie(
  headers: Record<string, string>
): string | null {
  // API Gateway v2 lowercases header keys.
  const raw = headers["cookie"] ?? headers["Cookie"] ?? undefined;
  return parseCookie(raw, SESSION_COOKIE);
}

// ---------------------------------------------------------------------------
// Verify a session cookie. Returns null on any failure (tampered, expired,
// wrong schema, secret unavailable).
// ---------------------------------------------------------------------------

export async function verifySessionCookie(
  cookie: string
): Promise<{ email: string } | null> {
  const secret = await getAgentSecret();
  if (!secret) return null;
  const payload = verifyToken<SessionPayload>(secret, cookie);
  if (!payload) return null;
  if (payload.kind !== "session" || payload.v !== 1) return null;
  if (payload.schema !== (process.env.APP_SCHEMA ?? "")) return null;
  if (payload.exp * 1000 < Date.now()) return null;
  return { email: payload.email };
}

// ---------------------------------------------------------------------------
// Bootstrap response shape (returned by handler.js directly)
// ---------------------------------------------------------------------------

export interface BootstrapResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  cookies?: string[];
}

function unauthorizedResponse(): BootstrapResponse {
  return {
    statusCode: 401,
    headers: { "Content-Type": "text/plain" },
    body: "Unauthorized",
  };
}

function validateRedirect(raw: string | undefined): string {
  if (!raw) return "/";
  // Only allow relative redirects starting with a single leading slash.
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw;
}

// ---------------------------------------------------------------------------
// Entry point — the agent's handler MUST call this before anything else
// ---------------------------------------------------------------------------

/**
 * If the incoming request is an agent-bootstrap request, consume the bootstrap
 * token, mint a 30-min session cookie, and return a 302 redirect. Returns
 * null if the request is not an agent-bootstrap request (handler continues
 * normal processing).
 */
export async function handleAgentBootstrap(
  event: APIGatewayProxyEventV2
): Promise<BootstrapResponse | null> {
  const schema = process.env.APP_SCHEMA ?? "";
  const rawPath = event.rawPath ?? "";

  // Match /{schema}/__hereya/agent-bootstrap
  const expected = `/${schema}${BOOTSTRAP_PATH}`;
  if (rawPath !== expected) return null;

  const secret = await getAgentSecret();
  if (!secret) return unauthorizedResponse();

  const token = event.queryStringParameters?.token;
  if (!token) return unauthorizedResponse();

  const payload = verifyToken<BootstrapPayload>(secret, token);
  if (!payload) return unauthorizedResponse();
  if (payload.kind !== "bootstrap" || payload.v !== 1) {
    return unauthorizedResponse();
  }
  if (payload.schema !== schema) return unauthorizedResponse();
  if (payload.exp * 1000 < Date.now()) return unauthorizedResponse();

  // Atomically claim the jti. Replays lose the race.
  const won = await claimJti(payload.jti, payload.exp);
  if (!won) return unauthorizedResponse();

  // Best-effort cleanup of stale jtis.
  sweepExpiredJtis();

  const { token: sessionToken } = mintSessionToken(secret, {
    schema,
    email: payload.email,
  });

  const redirect = validateRedirect(event.queryStringParameters?.redirect);
  const redirectUrl = `/${schema}${redirect === "/" ? "" : redirect}`;

  return {
    statusCode: 302,
    headers: {
      Location: redirectUrl || "/",
      "Cache-Control": "no-store",
    },
    cookies: [buildSessionCookie(sessionToken)],
    body: "",
  };
}
