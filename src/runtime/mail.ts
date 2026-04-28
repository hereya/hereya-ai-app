// ---------------------------------------------------------------------------
// Per-app Lambda runtime helper for sending mail via the app's own Postmark
// server. Mirrors the MCP send-mail tool API but runs inside the per-app
// Lambda at request time. Token is read from SSM on first use and cached for
// the container's lifetime — rotations need a Lambda recycle.
//
// Requires enable-auth to have run for the app: the org Lambda injects
// POSTMARK_SERVER_TOKEN_SSM_PATH and POSTMARK_FROM_DOMAIN into per-app
// Lambdas via buildAppEnv when public._app_auth has a row for the schema.
// ---------------------------------------------------------------------------

import {
  SSMClient,
  GetParameterCommand,
  ParameterNotFound,
} from "@aws-sdk/client-ssm";

const ssm = new SSMClient({ region: process.env.awsRegion });

const LOCAL_PART_RE = /^[a-z0-9._+-]{1,64}$/i;

let cachedToken: string | null | undefined;

async function getServerToken(): Promise<string> {
  if (cachedToken !== undefined && cachedToken !== null) return cachedToken;
  const path = process.env.POSTMARK_SERVER_TOKEN_SSM_PATH;
  if (!path) {
    throw new Error(
      "POSTMARK_SERVER_TOKEN_SSM_PATH not set — enable-auth has not run for this app."
    );
  }
  try {
    const result = await ssm.send(
      new GetParameterCommand({ Name: path, WithDecryption: true })
    );
    const value = result.Parameter?.Value;
    if (!value) {
      throw new Error(
        `SSM parameter ${path} returned no value — re-run enable-auth to repair.`
      );
    }
    cachedToken = value;
    return value;
  } catch (err: unknown) {
    if (err instanceof ParameterNotFound) {
      throw new Error(
        `Postmark server token missing in SSM (${path}) — re-run enable-auth.`
      );
    }
    throw err;
  }
}

function defaultFromDomain(): string {
  const d = process.env.POSTMARK_FROM_DOMAIN;
  if (!d) {
    throw new Error(
      "POSTMARK_FROM_DOMAIN not set — enable-auth has not run for this app."
    );
  }
  return d;
}

// Active senders this per-app Lambda is allowed to forge From on. Comma-
// separated list injected by buildAppEnv: starts with the default internal
// domain and includes every _custom_domains row for this schema where
// email_status = 'active'. Re-populated on each deploy-backend /
// redeploy-backend.
function allowedFromDomains(): Set<string> {
  const raw = process.env.POSTMARK_FROM_DOMAIN_ALLOW;
  if (!raw) {
    // Fallback: only the default is allowed. Lets older per-app Lambdas
    // that predate the allow-list env var keep sending.
    return new Set([defaultFromDomain()]);
  }
  return new Set(
    raw
      .split(",")
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean)
  );
}

function baseUrl(): string {
  return process.env.postmarkApiBaseUrl ?? "https://api.postmarkapp.com";
}

export type MailStream = "transactional" | "broadcast";

export interface SendOptions {
  to: string;
  subject: string;
  body_html?: string;
  body_text?: string;
  from_local_part?: string;
  from_name?: string;
  /**
   * Verified custom domain to send from (e.g. "acme.com"). Must be in the
   * allow-list injected via POSTMARK_FROM_DOMAIN_ALLOW. Omit to send from
   * the default internal {schema}.{customDomain} sender.
   */
  from_domain?: string;
  stream?: MailStream;
}

export interface SendResult {
  message_id: string;
  submitted_at: string;
  to: string;
  from: string;
  stream: MailStream;
}

export async function send(opts: SendOptions): Promise<SendResult> {
  if (!opts.to) throw new Error("`to` is required");
  if (!opts.subject) throw new Error("`subject` is required");
  if (!opts.body_html && !opts.body_text) {
    throw new Error("At least one of body_html / body_text is required");
  }

  const localPart = opts.from_local_part ?? "noreply";
  if (!LOCAL_PART_RE.test(localPart)) {
    throw new Error(
      `from_local_part must match [a-z0-9._+-]{1,64}; got "${localPart}"`
    );
  }

  const schemaLabel = process.env.APP_SCHEMA ?? "app";
  const displayName = (opts.from_name ?? schemaLabel).replace(/"/g, "'");

  // Pick the From domain. Default = the app's internal signed subdomain;
  // caller-supplied from_domain must appear in the allow-list env var (which
  // buildAppEnv refreshes on every deploy-backend with the set of active
  // custom domains for this schema).
  const defaultDomain = defaultFromDomain();
  let fromDomainValue = defaultDomain;
  if (opts.from_domain && opts.from_domain.toLowerCase() !== defaultDomain) {
    const requested = opts.from_domain.toLowerCase();
    const allow = allowedFromDomains();
    if (!allow.has(requested)) {
      throw new Error(
        `from_domain "${opts.from_domain}" is not in the active sender allow-list. ` +
          `Add it via set-custom-domains, wait for email_status='active', then redeploy the backend to refresh the allow-list.`
      );
    }
    fromDomainValue = requested;
  }
  const from = `"${displayName}" <${localPart}@${fromDomainValue}>`;

  const stream: MailStream = opts.stream ?? "transactional";
  const messageStreamId = stream === "broadcast" ? "broadcast" : "outbound";

  const token = await getServerToken();

  const res = await fetch(`${baseUrl()}/email`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Postmark-Server-Token": token,
    },
    body: JSON.stringify({
      From: from,
      To: opts.to,
      Subject: opts.subject,
      HtmlBody: opts.body_html,
      TextBody: opts.body_text,
      MessageStream: messageStreamId,
    }),
  });

  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { Message: text };
  }
  if (!res.ok) {
    throw new Error(
      `Postmark send failed (${res.status}): ${
        (parsed as { Message?: string }).Message ?? text
      }`
    );
  }

  return {
    message_id: parsed.MessageID as string,
    submitted_at: parsed.SubmittedAt as string,
    to: parsed.To as string,
    from,
    stream,
  };
}
