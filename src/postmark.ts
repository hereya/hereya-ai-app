// Minimal Postmark account-level API client.
//
// Used by the org Lambda to create and delete per-app Postmark servers and
// sender domains on behalf of agents calling the `enable-auth` tool. Reads
// postmarkAccountToken (resolved at cold start by src/secrets.ts) and
// postmarkApiBaseUrl from env. Account token authorizes account-scope
// endpoints (/servers, /domains); per-server tokens are stored separately in
// SSM.

export interface PostmarkServer {
  ID: number;
  Name: string;
  ApiTokens: string[];
}

export interface PostmarkDomain {
  ID: number;
  Name: string;
  DKIMPendingHost: string;
  DKIMPendingTextValue: string;
  DKIMHost?: string;
  DKIMTextValue?: string;
  DKIMVerified?: boolean;
  ReturnPathDomain: string;
  ReturnPathDomainCNAMEValue: string;
  ReturnPathDomainVerified?: boolean;
}

function accountToken(): string {
  const token = process.env.postmarkAccountToken;
  if (!token) {
    throw new Error(
      "postmarkAccountToken missing — the hereya/postmark-account-credentials package must be installed and the workspace env must provide the token."
    );
  }
  return token;
}

function baseUrl(): string {
  return process.env.postmarkApiBaseUrl ?? "https://api.postmarkapp.com";
}

async function request<T>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: Record<string, unknown>
): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`, {
    method,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Postmark-Account-Token": accountToken(),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { Message: text };
  }

  if (!res.ok) {
    const msg = (parsed as { Message?: string })?.Message ?? text;
    const err = new Error(`Postmark ${method} ${path} → ${res.status}: ${msg}`);
    (err as Error & { status: number; errorCode?: number }).status = res.status;
    (err as Error & { errorCode?: number }).errorCode = (parsed as { ErrorCode?: number })?.ErrorCode;
    throw err;
  }

  return parsed as T;
}

export async function createServer(name: string): Promise<PostmarkServer> {
  return request<PostmarkServer>("POST", "/servers", {
    Name: name,
    DeliveryType: "Live",
    TrackOpens: false,
    TrackLinks: "None",
  });
}

export async function deleteServer(id: number): Promise<void> {
  await request<unknown>("DELETE", `/servers/${id}`);
}

export async function findServerByName(
  name: string
): Promise<PostmarkServer | null> {
  const res = await request<{ TotalCount: number; Servers: PostmarkServer[] }>(
    "GET",
    `/servers?count=500&offset=0&name=${encodeURIComponent(name)}`
  );
  const exact = res.Servers?.find((s) => s.Name === name);
  return exact ?? null;
}

export async function createDomain(name: string): Promise<PostmarkDomain> {
  // ReturnPathDomain must be a subdomain of the sender domain for Postmark
  // to accept it (mirrors what hereya-postmark-server does via Terraform).
  return request<PostmarkDomain>("POST", "/domains", {
    Name: name,
    ReturnPathDomain: `pm-bounces.${name}`,
  });
}

export async function getDomain(id: number): Promise<PostmarkDomain> {
  return request<PostmarkDomain>("GET", `/domains/${id}`);
}

export async function deleteDomain(id: number): Promise<void> {
  await request<unknown>("DELETE", `/domains/${id}`);
}

export async function findDomainByName(
  name: string
): Promise<PostmarkDomain | null> {
  const res = await request<{ TotalCount: number; Domains: PostmarkDomain[] }>(
    "GET",
    `/domains?count=500&offset=0`
  );
  return res.Domains?.find((d) => d.Name === name) ?? null;
}

// Returns true once BOTH DKIM and ReturnPathDomain are verified on Postmark's
// side — i.e. the user has pointed the DNS at the values we handed them.
// Keeps the poll light by hitting the single-domain endpoint.
export async function isDomainVerified(id: number): Promise<boolean> {
  const d = await getDomain(id);
  return Boolean(d.DKIMVerified) && Boolean(d.ReturnPathDomainVerified);
}

// Force Postmark to re-check the DNS records for a domain. Useful when we
// want to turn a pending_verification row into active without waiting for
// Postmark's internal re-check cadence.
export async function verifyDomain(id: number): Promise<PostmarkDomain> {
  const d = await request<PostmarkDomain>("POST", `/domains/${id}/verifyDkim`);
  await request<PostmarkDomain>("POST", `/domains/${id}/verifyReturnPath`).catch(
    () => undefined
  );
  return d;
}

// ---------------------------------------------------------------------------
// Server-level operations — use the per-server token, not the account token.
// ---------------------------------------------------------------------------

async function serverRequest<T>(
  serverToken: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: Record<string, unknown>
): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`, {
    method,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Postmark-Server-Token": serverToken,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { Message: text };
  }

  if (!res.ok) {
    const msg = (parsed as { Message?: string })?.Message ?? text;
    const err = new Error(
      `Postmark ${method} ${path} → ${res.status}: ${msg}`
    );
    (err as Error & { status: number; errorCode?: number }).status = res.status;
    (err as Error & { errorCode?: number }).errorCode = (
      parsed as { ErrorCode?: number }
    )?.ErrorCode;
    throw err;
  }

  return parsed as T;
}

// Server renaming uses the account token (account-scope endpoint).
export async function renameServer(id: number, name: string): Promise<void> {
  await request<unknown>("PUT", `/servers/${id}`, { Name: name });
}

export type PostmarkStream = "transactional" | "broadcast";

// Map our API surface onto Postmark's internal stream IDs.
export function postmarkStreamId(stream: PostmarkStream): string {
  return stream === "broadcast" ? "broadcast" : "outbound";
}

export interface SendEmailInput {
  From: string;
  To: string;
  Subject: string;
  HtmlBody?: string;
  TextBody?: string;
  MessageStream: string;
}

export interface SendEmailResult {
  MessageID: string;
  SubmittedAt: string;
  To: string;
  ErrorCode?: number;
  Message?: string;
}

export async function sendEmail(
  serverToken: string,
  payload: SendEmailInput
): Promise<SendEmailResult> {
  return serverRequest<SendEmailResult>(serverToken, "POST", "/email", {
    ...payload,
  });
}

// Idempotent — tolerates "already exists" responses so drift-correct is safe.
export async function ensureBroadcastStream(serverToken: string): Promise<void> {
  try {
    await serverRequest<unknown>(serverToken, "POST", "/message-streams", {
      ID: "broadcast",
      Name: "Broadcast",
      MessageStreamType: "Broadcasts",
    });
  } catch (err: unknown) {
    const status = (err as { status?: number })?.status;
    // 422 — stream already exists on this server. Anything else is a real error.
    if (status !== 422) throw err;
  }
}
