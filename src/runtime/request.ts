import type { APIGatewayProxyEventV2 } from "aws-lambda";
import {
  readSessionCookie,
  verifySessionCookie,
} from "./agent-auth.js";

// ---------------------------------------------------------------------------
// AppRequest — friendly interface for per-app Lambda handlers
// ---------------------------------------------------------------------------

export interface AppRequest {
  path: string;
  method: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  body: string | null;
  auth: {
    authenticated: boolean;
    email: string | null;
    cognito_sub: string | null;
    agent?: boolean;
  };
  schema: string;
}

// ---------------------------------------------------------------------------
// parseRequest — converts raw API Gateway event to AppRequest
//
// Auth resolution order:
//   1. Cognito JWT via the Frontend Authorizer (requestContext.authorizer.lambda).
//      Real humans take precedence — if Cognito says someone is signed in, we
//      never shadow them with an agent session.
//   2. Agent session cookie (hereya_agent) verified with the per-app secret.
//      Sets req.auth.agent = true so handlers can audit/restrict agents.
//   3. Unauthenticated otherwise.
// ---------------------------------------------------------------------------

export async function parseRequest(
  event: APIGatewayProxyEventV2
): Promise<AppRequest> {
  const schema = process.env.APP_SCHEMA ?? "";

  // Strip the /{schema} prefix from rawPath
  let path = event.rawPath;
  const schemaPrefix = `/${schema}`;
  if (path.startsWith(schemaPrefix)) {
    path = path.slice(schemaPrefix.length) || "/";
  }

  // Extract Cognito auth context from frontend authorizer
  const authorizer = (
    event.requestContext as unknown as Record<string, unknown>
  )?.authorizer as { lambda?: Record<string, string> } | undefined;
  const ctx = authorizer?.lambda;

  const body = event.isBase64Encoded
    ? Buffer.from(event.body ?? "", "base64").toString()
    : event.body ?? null;

  const headers = (event.headers ?? {}) as Record<string, string>;

  // Cognito wins — check it first.
  if (ctx?.email) {
    return {
      path,
      method: event.requestContext.http.method,
      headers,
      query: (event.queryStringParameters ?? {}) as Record<string, string>,
      body,
      auth: {
        authenticated: true,
        email: ctx.email,
        cognito_sub: ctx.cognito_sub ?? null,
      },
      schema,
    };
  }

  // Fall back to agent session cookie.
  const cookie = readSessionCookie(headers);
  if (cookie) {
    const verified = await verifySessionCookie(cookie);
    if (verified) {
      return {
        path,
        method: event.requestContext.http.method,
        headers,
        query: (event.queryStringParameters ?? {}) as Record<string, string>,
        body,
        auth: {
          authenticated: true,
          email: verified.email,
          cognito_sub: null,
          agent: true,
        },
        schema,
      };
    }
  }

  // Unauthenticated
  return {
    path,
    method: event.requestContext.http.method,
    headers,
    query: (event.queryStringParameters ?? {}) as Record<string, string>,
    body,
    auth: {
      authenticated: false,
      email: null,
      cognito_sub: null,
    },
    schema,
  };
}
