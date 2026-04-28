import { createHmac, timingSafeEqual, randomUUID } from "crypto";

// ---------------------------------------------------------------------------
// Pure HMAC signing helpers shared between the org Lambda (which MINTS tokens
// inside MCP tools) and the per-app Lambda runtime (which VERIFIES them).
// No runtime dependencies — safe to import from either side.
// ---------------------------------------------------------------------------

export const BOOTSTRAP_TTL_SECONDS = 300; // 5 min
export const SESSION_TTL_SECONDS = 1800; // 30 min

export interface BootstrapPayload {
  v: 1;
  kind: "bootstrap";
  schema: string;
  email: string;
  exp: number;
  jti: string;
}

export interface SessionPayload {
  v: 1;
  kind: "session";
  schema: string;
  email: string;
  exp: number;
}

function base64urlEncode(buf: Buffer | string): string {
  const b = typeof buf === "string" ? Buffer.from(buf, "utf8") : buf;
  return b
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64urlDecode(s: string): Buffer {
  const padding = (4 - (s.length % 4)) % 4;
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(padding);
  return Buffer.from(b64, "base64");
}

function signPayload(secret: string, payloadJson: string): string {
  return base64urlEncode(
    createHmac("sha256", secret).update(payloadJson).digest()
  );
}

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function signToken<T extends object>(secret: string, payload: T): string {
  const json = JSON.stringify(payload);
  const body = base64urlEncode(json);
  const sig = signPayload(secret, json);
  return `${body}.${sig}`;
}

export function verifyToken<T extends object>(
  secret: string,
  token: string
): T | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  let json: string;
  try {
    json = base64urlDecode(body).toString("utf8");
  } catch {
    return null;
  }
  const expected = signPayload(secret, json);
  if (!constantTimeEqual(sig, expected)) return null;
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

export function mintBootstrapToken(
  secret: string,
  params: { schema: string; email: string; ttlSeconds?: number }
): { token: string; jti: string; exp: number } {
  const exp =
    Math.floor(Date.now() / 1000) +
    (params.ttlSeconds ?? BOOTSTRAP_TTL_SECONDS);
  const jti = randomUUID();
  const payload: BootstrapPayload = {
    v: 1,
    kind: "bootstrap",
    schema: params.schema,
    email: params.email,
    exp,
    jti,
  };
  const token = signToken(secret, payload);
  return { token, jti, exp };
}

export function mintSessionToken(
  secret: string,
  params: { schema: string; email: string; ttlSeconds?: number }
): { token: string; exp: number } {
  const exp =
    Math.floor(Date.now() / 1000) +
    (params.ttlSeconds ?? SESSION_TTL_SECONDS);
  const payload: SessionPayload = {
    v: 1,
    kind: "session",
    schema: params.schema,
    email: params.email,
    exp,
  };
  return { token: signToken(secret, payload), exp };
}
