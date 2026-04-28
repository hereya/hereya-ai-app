// Custom domain lifecycle for per-app frontends.
//
// Architecture:
//   - Each org has a single CloudFront distribution serving both subdomains
//     (`{app}.{customDomain}`) and custom vanity domains (e.g. `orders.acme.com`).
//   - CloudFront supports exactly one ViewerCertificate per distribution. That
//     cert carries many SANs. The wildcard `*.${customDomain}` is always one
//     of the SANs, so the subdomain routing keeps working regardless of custom
//     domains.
//   - CDK bootstraps the initial wildcard cert and stores its ARN in SSM. The
//     CDK stack reads the ARN from SSM (not from a managed ACM resource), so
//     subsequent runtime cert swaps do not drift CDK.
//
// `set-custom-domains` is a bulk-replace operation: the caller passes the full
// desired list for one schema, a new multi-SAN cert is issued, and on
// `check-custom-domains` the new cert + updated CF function replace the old
// ones atomically from the distribution's point of view.

import {
  ACMClient,
  RequestCertificateCommand,
  DescribeCertificateCommand,
  DeleteCertificateCommand,
} from "@aws-sdk/client-acm";
import {
  CloudFrontClient,
  GetDistributionCommand,
  UpdateDistributionCommand,
  DescribeFunctionCommand,
  UpdateFunctionCommand,
  PublishFunctionCommand,
} from "@aws-sdk/client-cloudfront";
import {
  SSMClient,
  GetParameterCommand,
  PutParameterCommand,
  ParameterNotFound,
} from "@aws-sdk/client-ssm";
import { sql, convertParams, extractFieldValue } from "./db.js";
import { renderCloudFrontFunction, type DomainMap } from "./custom-domain-template.js";
import { getAppAuthStatus } from "./app-auth.js";
import {
  createDomain as postmarkCreateDomain,
  findDomainByName as postmarkFindDomainByName,
  getDomain as postmarkGetDomain,
  deleteDomain as postmarkDeleteDomain,
  isDomainVerified as postmarkIsDomainVerified,
  verifyDomain as postmarkVerifyDomain,
} from "./postmark.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const region = () => process.env.awsRegion ?? "us-east-1";
const customDomain = () => process.env.customDomain ?? "";
const orgId = () =>
  process.env.BOUND_ORG_ID ?? process.env.ORGANIZATION_ID ?? "";
const distributionId = () => process.env.CLOUDFRONT_DISTRIBUTION_ID ?? "";
const cfFunctionName = () => process.env.CLOUDFRONT_FUNCTION_NAME ?? "";
const cfDomain = () => process.env.CLOUDFRONT_DOMAIN ?? "";
const viewerCertSsmParam = () =>
  process.env.VIEWER_CERT_SSM_PARAM ?? `/hereya/${orgId()}/viewer-cert-arn`;

// CloudFront certs must live in us-east-1
let _acm: ACMClient | undefined;
let _cf: CloudFrontClient | undefined;
let _ssm: SSMClient | undefined;
const acm = () => (_acm ??= new ACMClient({ region: "us-east-1" }));
const cf = () => (_cf ??= new CloudFrontClient({ region: region() }));
const ssm = () => (_ssm ??= new SSMClient({ region: region() }));

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class CustomDomainError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "CustomDomainError";
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DomainStatus = "active" | "pending_validation" | "pending_removal";

// Email signature lifecycle:
//   pending_enable_auth  -> set-custom-domains ran before enable-auth
//   pending_verification -> Postmark signature created; waiting on DKIM DNS
//   active               -> Postmark verified; domain is a valid `from_domain`
//   removed              -> being torn down alongside an ACM swap
export type EmailStatus =
  | "pending_enable_auth"
  | "pending_verification"
  | "active"
  | "removed";

export interface DomainRow {
  domain: string;
  schema_name: string;
  status: DomainStatus;
  cert_arn: string | null;
  pending_cert_arn: string | null;
  canonical_domain: string | null;
  postmark_domain_id: number | null;
  email_status: EmailStatus;
}

export interface ValidationRecord {
  domain: string;
  name: string;
  type: string;
  value: string;
}

export interface EmailRecord {
  domain: string;
  name: string;
  type: "TXT" | "CNAME";
  value: string;
  purpose: "dkim" | "return-path";
}

export interface RoutingRecord {
  record_type: "CNAME" | "ALIAS";
  value: string;
}

export interface DomainInfo {
  domain: string;
  schema: string;
  status: DomainStatus;
  kind: "apex" | "subdomain";
  routing: RoutingRecord;
  canonical: string | null;
  redirects_to_canonical: boolean;
  email_status: EmailStatus;
}

// ---------------------------------------------------------------------------
// Domain validation + classification
// ---------------------------------------------------------------------------

// RFC 1035-ish domain match. Rejects leading/trailing dots, wildcards (caller
// should never pass `*`), and empty labels.
const DOMAIN_RE =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/i;

export function isValidDomain(d: string): boolean {
  return DOMAIN_RE.test(d);
}

// Heuristic apex detection: a single dot ⇒ apex (e.g. "acme.com").
// Misses multi-label TLDs ("acme.co.uk"); docs call out the edge case and the
// user-facing record type (`CNAME` vs `ALIAS`) is ultimately decided by whether
// the user's DNS provider allows a CNAME at the level they supply.
export function domainKind(d: string): "apex" | "subdomain" {
  return d.split(".").length === 2 ? "apex" : "subdomain";
}

function routingFor(d: string): RoutingRecord {
  return {
    record_type: domainKind(d) === "apex" ? "ALIAS" : "CNAME",
    value: cfDomain(),
  };
}

function rowToDomainInfo(row: DomainRow): DomainInfo {
  const canonical = row.canonical_domain;
  return {
    domain: row.domain,
    schema: row.schema_name,
    status: row.status,
    kind: domainKind(row.domain),
    routing: routingFor(row.domain),
    canonical,
    redirects_to_canonical: canonical !== null && canonical !== row.domain,
    email_status: row.email_status,
  };
}

// ---------------------------------------------------------------------------
// Table bootstrap
// ---------------------------------------------------------------------------

let tableReady = false;

// Exported so call sites in other modules that hit _custom_domains directly
// (e.g. src/tools/mail.ts, buildAppEnv) can trigger the additive migrations
// before running their SELECTs on cold containers.
export async function ensureCustomDomainsTable(): Promise<void> {
  return ensureTable();
}

async function ensureTable(): Promise<void> {
  if (tableReady) return;
  await sql(`
    CREATE TABLE IF NOT EXISTS public._custom_domains (
      domain VARCHAR(255) PRIMARY KEY,
      schema_name VARCHAR(63) NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'pending_validation',
      cert_arn VARCHAR(500),
      pending_cert_arn VARCHAR(500),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Additive migration — NULL means "no canonical assigned yet, this host
  // serves its own schema directly". Existing rows get NULL and keep the old
  // (pre-canonical) behavior until the operator re-runs set-custom-domains.
  await sql(
    `ALTER TABLE public._custom_domains ADD COLUMN IF NOT EXISTS canonical_domain VARCHAR(255)`
  );
  // Email-signature tracking (Postmark). `postmark_domain_id` is NULL until
  // the app has enable-auth. `email_status` transitions:
  //   pending_enable_auth -> pending_verification -> active -> removed
  await sql(
    `ALTER TABLE public._custom_domains ADD COLUMN IF NOT EXISTS postmark_domain_id INTEGER`
  );
  await sql(
    `ALTER TABLE public._custom_domains ADD COLUMN IF NOT EXISTS email_status VARCHAR(32) DEFAULT 'pending_enable_auth'`
  );
  await sql(
    `CREATE INDEX IF NOT EXISTS _custom_domains_schema_idx ON public._custom_domains(schema_name)`
  );
  tableReady = true;
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

async function loadAllRows(): Promise<DomainRow[]> {
  await ensureTable();
  const result = await sql(
    `SELECT domain, schema_name, status, cert_arn, pending_cert_arn,
            canonical_domain, postmark_domain_id, email_status
       FROM public._custom_domains`
  );
  return (result.records ?? []).map((r) => {
    const pmId = extractFieldValue(r[6]);
    return {
      domain: extractFieldValue(r[0]) as string,
      schema_name: extractFieldValue(r[1]) as string,
      status: extractFieldValue(r[2]) as DomainStatus,
      cert_arn: (extractFieldValue(r[3]) as string | null) ?? null,
      pending_cert_arn: (extractFieldValue(r[4]) as string | null) ?? null,
      canonical_domain: (extractFieldValue(r[5]) as string | null) ?? null,
      postmark_domain_id:
        pmId === null || pmId === undefined ? null : Number(pmId),
      email_status:
        ((extractFieldValue(r[7]) as EmailStatus | null) ??
          "pending_enable_auth") as EmailStatus,
    };
  });
}

async function hasPendingWork(rows: DomainRow[]): Promise<boolean> {
  return rows.some(
    (r) =>
      r.status === "pending_validation" ||
      r.status === "pending_removal" ||
      r.pending_cert_arn !== null
  );
}

// ---------------------------------------------------------------------------
// SSM helpers (the viewer-cert-arn parameter is not a secret, so we don't
// reuse src/ssm.ts which stores SecureString)
// ---------------------------------------------------------------------------

async function readCurrentCertArn(): Promise<string | null> {
  try {
    const res = await ssm().send(
      new GetParameterCommand({ Name: viewerCertSsmParam() })
    );
    return res.Parameter?.Value ?? null;
  } catch (err: any) {
    if (err instanceof ParameterNotFound || err?.name === "ParameterNotFound") {
      return null;
    }
    throw err;
  }
}

async function writeCurrentCertArn(arn: string): Promise<void> {
  await ssm().send(
    new PutParameterCommand({
      Name: viewerCertSsmParam(),
      Value: arn,
      Type: "String",
      Overwrite: true,
    })
  );
}

// ---------------------------------------------------------------------------
// CloudFront distribution helpers
// ---------------------------------------------------------------------------

async function getDistributionState() {
  const res = await cf().send(
    new GetDistributionCommand({ Id: distributionId() })
  );
  if (!res.Distribution || !res.ETag) {
    throw new CustomDomainError(
      "CLOUDFRONT_UPDATE_FAILED",
      "Distribution not found or missing ETag"
    );
  }
  return { distribution: res.Distribution, etag: res.ETag };
}

// ---------------------------------------------------------------------------
// ACM helpers
// ---------------------------------------------------------------------------

async function requestCertificate(
  sans: string[],
  schema: string,
  domainsCsv: string
): Promise<string> {
  if (sans.length === 0) {
    throw new CustomDomainError(
      "INVALID_DOMAIN",
      "Cannot request a cert with zero SANs"
    );
  }
  const [primary, ...rest] = sans;
  const res = await acm().send(
    new RequestCertificateCommand({
      DomainName: primary,
      SubjectAlternativeNames: rest.length > 0 ? rest : undefined,
      ValidationMethod: "DNS",
      Tags: [
        { Key: "hereya:orgId", Value: orgId() },
        { Key: "hereya:schema", Value: schema },
        { Key: "hereya:domains", Value: domainsCsv },
      ],
    })
  );
  if (!res.CertificateArn) {
    throw new CustomDomainError(
      "CLOUDFRONT_UPDATE_FAILED",
      "ACM did not return a certificate ARN"
    );
  }
  return res.CertificateArn;
}

// Poll DescribeCertificate up to `timeoutMs` until ResourceRecord info is
// populated for every non-wildcard SAN. ACM usually populates these within a
// couple of seconds.
async function fetchValidationRecords(
  certArn: string,
  newDomains: Set<string>,
  timeoutMs = 15_000
): Promise<ValidationRecord[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await acm().send(
      new DescribeCertificateCommand({ CertificateArn: certArn })
    );
    const opts = res.Certificate?.DomainValidationOptions ?? [];
    const records: ValidationRecord[] = [];
    let allReady = true;
    for (const opt of opts) {
      if (!opt.DomainName || !newDomains.has(opt.DomainName)) continue;
      if (!opt.ResourceRecord?.Name) {
        allReady = false;
        break;
      }
      records.push({
        domain: opt.DomainName,
        name: opt.ResourceRecord.Name,
        type: opt.ResourceRecord.Type ?? "CNAME",
        value: opt.ResourceRecord.Value ?? "",
      });
    }
    if (allReady) return records;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new CustomDomainError(
    "CERT_NOT_ISSUED",
    "ACM did not populate validation records in time. Retry check-custom-domains."
  );
}

async function describeCertStatus(certArn: string): Promise<string> {
  const res = await acm().send(
    new DescribeCertificateCommand({ CertificateArn: certArn })
  );
  return res.Certificate?.Status ?? "UNKNOWN";
}

async function deleteCertificateQuiet(arn: string): Promise<void> {
  try {
    await acm().send(new DeleteCertificateCommand({ CertificateArn: arn }));
  } catch {
    // best-effort — cert may already be gone, or still attached during
    // propagation. CloudFront eventually detaches; a scheduled sweep can clean up.
  }
}

// ---------------------------------------------------------------------------
// Postmark email-signature helpers
// ---------------------------------------------------------------------------

// Create a Postmark domain signature idempotently. Returns the Postmark
// domain object on success. On 422 / 409 (already exists), looks up the
// existing signature by name. Used when set-custom-domains (or createAppAuth
// backfill) wants a signature for a user-owned vanity domain.
async function ensurePostmarkDomain(domain: string) {
  return postmarkCreateDomain(domain).catch(async (err: unknown) => {
    const status = (err as { status?: number })?.status;
    if (status === 422 || status === 409) {
      const existing = await postmarkFindDomainByName(domain);
      if (existing) return existing;
    }
    throw err;
  });
}

// Build DKIM TXT + return-path CNAME DNS records the user must add to their
// registrar. Mirrors the shape of ValidationRecord so agents can surface both
// lists together.
function postmarkRecords(pm: {
  Name: string;
  DKIMPendingHost: string;
  DKIMPendingTextValue: string;
  DKIMHost?: string;
  DKIMTextValue?: string;
  ReturnPathDomain: string;
  ReturnPathDomainCNAMEValue: string;
}): EmailRecord[] {
  // Postmark returns DKIM values in either DKIMPending* (before first
  // verification) or DKIM* (after). Prefer the pending ones; fall back.
  const dkimHost = pm.DKIMPendingHost || pm.DKIMHost || "";
  const dkimValue = pm.DKIMPendingTextValue || pm.DKIMTextValue || "";
  return [
    {
      domain: pm.Name,
      name: dkimHost,
      type: "TXT",
      value: dkimValue,
      purpose: "dkim",
    },
    {
      domain: pm.Name,
      name: pm.ReturnPathDomain,
      type: "CNAME",
      value: pm.ReturnPathDomainCNAMEValue,
      purpose: "return-path",
    },
  ];
}

// ---------------------------------------------------------------------------
// Core operations
// ---------------------------------------------------------------------------

export async function setCustomDomains(
  schema: string,
  requested: string[]
): Promise<{
  status: "no_change" | "pending_validation";
  validation_records: ValidationRecord[];
  email_records: EmailRecord[];
  domains: DomainInfo[];
}> {
  if (!customDomain()) {
    throw new CustomDomainError(
      "CLOUDFRONT_UPDATE_FAILED",
      "customDomain env var is not set — stack not ready"
    );
  }
  if (!distributionId() || !cfFunctionName()) {
    throw new CustomDomainError(
      "CLOUDFRONT_UPDATE_FAILED",
      "CloudFront env vars not set — stack not upgraded yet"
    );
  }

  // Validate domains
  const normalized = [...new Set(requested.map((d) => d.toLowerCase().trim()))];
  for (const d of normalized) {
    if (!isValidDomain(d)) {
      throw new CustomDomainError(
        "INVALID_DOMAIN",
        `"${d}" is not a valid domain name`
      );
    }
    if (d === customDomain() || d.endsWith("." + customDomain())) {
      throw new CustomDomainError(
        "INVALID_DOMAIN",
        `"${d}" is inside the default domain namespace (${customDomain()}) and is already served`
      );
    }
  }

  await ensureTable();

  // Block if the CloudFront distribution is still deploying a prior update
  const { distribution } = await getDistributionState();
  if (distribution.Status !== "Deployed") {
    throw new CustomDomainError(
      "REQUEST_IN_FLIGHT",
      `CloudFront distribution is ${distribution.Status}; wait for deployment before changing custom domains`
    );
  }

  const allRows = await loadAllRows();
  if (await hasPendingWork(allRows)) {
    throw new CustomDomainError(
      "REQUEST_IN_FLIGHT",
      "A cert request is already in flight. Call check-custom-domains first."
    );
  }

  const thisSchemaActive = new Set(
    allRows.filter((r) => r.schema_name === schema && r.status === "active").map((r) => r.domain)
  );
  const otherActive = allRows
    .filter((r) => r.schema_name !== schema && r.status === "active")
    .map((r) => r.domain);

  const requestedSet = new Set(normalized);
  // Last domain in the caller's list becomes canonical; the rest 301 to it.
  // `null` when the list is empty (full removal).
  const canonical =
    normalized.length > 0 ? normalized[normalized.length - 1] : null;

  // Idempotent no-op: same set of hosts AND each existing row already has its
  // canonical_domain matching `canonical`. Mismatched canonical ⇒ not a no-op.
  const sameSet =
    requestedSet.size === thisSchemaActive.size &&
    [...requestedSet].every((d) => thisSchemaActive.has(d));
  const canonicalAlreadyAligned = allRows
    .filter((r) => r.schema_name === schema && r.status === "active")
    .every((r) => r.canonical_domain === canonical);
  if (sameSet && canonicalAlreadyAligned) {
    return {
      status: "no_change",
      validation_records: [],
      email_records: [],
      domains: allRows
        .filter((r) => r.schema_name === schema)
        .map(rowToDomainInfo),
    };
  }

  // Build the new SAN set: wildcard + other schemas' active + this schema's requested
  const newSans = [
    `*.${customDomain()}`,
    ...[...new Set([...otherActive, ...normalized])],
  ];

  // "+" is the separator: ACM tag values must match
  // [\p{L}\p{Z}\p{N}_.:\/=+\-@]*  — comma is not allowed.
  const newCertArn = await requestCertificate(
    newSans,
    schema,
    normalized.join("+")
  );

  // New domains = requested - already-active-for-this-schema
  const newDomains = new Set(
    [...requestedSet].filter((d) => !thisSchemaActive.has(d))
  );

  let validationRecords: ValidationRecord[] = [];
  try {
    if (newDomains.size > 0) {
      validationRecords = await fetchValidationRecords(newCertArn, newDomains);
    }
  } catch (err) {
    // Orphan the cert on failure — no DB state has been written yet.
    await deleteCertificateQuiet(newCertArn);
    throw err;
  }

  // Provision Postmark signatures for each new domain (if auth is enabled).
  // If the app hasn't run enable-auth yet, we leave email_status as
  // 'pending_enable_auth' and backfill later from createAppAuth's
  // idempotency path. Postmark errors don't block the frontend cert swap —
  // the row is stored without a postmark_domain_id; the next set-custom-
  // domains or enable-auth call retries.
  const appAuth = await getAppAuthStatus(schema);
  const emailRecords: EmailRecord[] = [];
  const newPostmarkDomains: Map<string, number> = new Map();
  if (appAuth) {
    for (const d of newDomains) {
      try {
        const pm = await ensurePostmarkDomain(d);
        newPostmarkDomains.set(d, pm.ID);
        emailRecords.push(...postmarkRecords(pm));
      } catch (err) {
        // Non-fatal: log and continue. The frontend still ships; the agent
        // can re-run set-custom-domains to retry email signature creation.
        console.error(
          `[set-custom-domains] Postmark signature create failed for ${d}:`,
          err
        );
      }
    }
    // For domains that were already active in this schema but don't yet have
    // a Postmark signature (because they pre-date this feature), fill them in.
    for (const row of allRows) {
      if (
        row.schema_name === schema &&
        row.status === "active" &&
        requestedSet.has(row.domain) &&
        !row.postmark_domain_id
      ) {
        try {
          const pm = await ensurePostmarkDomain(row.domain);
          newPostmarkDomains.set(row.domain, pm.ID);
          emailRecords.push(...postmarkRecords(pm));
        } catch (err) {
          console.error(
            `[set-custom-domains] Postmark backfill failed for ${row.domain}:`,
            err
          );
        }
      }
    }
  }

  // DB updates (sequential because RDS Data API has no cheap multi-statement tx)
  try {
    // a) Mark removed: previously-active in this schema, not in request.
    //    Also flip email_status -> 'removed' so downstream code knows to tear
    //    down the Postmark signature on cert swap.
    for (const row of allRows) {
      if (row.schema_name === schema && row.status === "active" && !requestedSet.has(row.domain)) {
        await sql(
          `UPDATE public._custom_domains
           SET status = 'pending_removal', pending_cert_arn = NULL,
               email_status = 'removed', updated_at = NOW()
           WHERE domain = :d`,
          convertParams({ d: row.domain })
        );
      }
    }

    // b) Other schemas' active rows inherit the pending cert
    for (const row of allRows) {
      if (row.schema_name !== schema && row.status === "active") {
        await sql(
          `UPDATE public._custom_domains
           SET pending_cert_arn = :arn, updated_at = NOW()
           WHERE domain = :d`,
          convertParams({ arn: newCertArn, d: row.domain })
        );
      }
    }

    // c) Requested domains already active for this schema — inherit pending
    //    cert AND the freshly-computed canonical. If we just backfilled a
    //    Postmark signature, persist the id + flip email_status.
    for (const d of requestedSet) {
      if (thisSchemaActive.has(d)) {
        const pmId = newPostmarkDomains.get(d);
        if (pmId !== undefined) {
          await sql(
            `UPDATE public._custom_domains
             SET pending_cert_arn = :arn, canonical_domain = :c,
                 postmark_domain_id = :pid,
                 email_status = 'pending_verification',
                 updated_at = NOW()
             WHERE domain = :d`,
            convertParams({ arn: newCertArn, c: canonical, pid: pmId, d })
          );
        } else {
          await sql(
            `UPDATE public._custom_domains
             SET pending_cert_arn = :arn, canonical_domain = :c, updated_at = NOW()
             WHERE domain = :d`,
            convertParams({ arn: newCertArn, c: canonical, d })
          );
        }
      }
    }

    // d) New requested domains — insert as pending_validation with canonical.
    //    email_status starts at 'pending_verification' if we got a Postmark
    //    signature, else 'pending_enable_auth'.
    for (const d of newDomains) {
      const pmId = newPostmarkDomains.get(d);
      const emailStatus: EmailStatus = pmId
        ? "pending_verification"
        : "pending_enable_auth";
      await sql(
        `INSERT INTO public._custom_domains
           (domain, schema_name, status, cert_arn, pending_cert_arn,
            canonical_domain, postmark_domain_id, email_status)
         VALUES (:d, :s, 'pending_validation', NULL, :arn, :c, :pid, :es)
         ON CONFLICT (domain) DO UPDATE SET
           schema_name = EXCLUDED.schema_name,
           status = 'pending_validation',
           pending_cert_arn = EXCLUDED.pending_cert_arn,
           canonical_domain = EXCLUDED.canonical_domain,
           postmark_domain_id = COALESCE(EXCLUDED.postmark_domain_id, public._custom_domains.postmark_domain_id),
           email_status = EXCLUDED.email_status,
           updated_at = NOW()`,
        convertParams({
          d,
          s: schema,
          arn: newCertArn,
          c: canonical,
          pid: pmId ?? null,
          es: emailStatus,
        })
      );
    }
  } catch (err) {
    await deleteCertificateQuiet(newCertArn);
    throw err;
  }

  // Reload so DomainInfo reflects the freshly-written canonical_domain +
  // postmark_domain_id + email_status.
  const refreshed = await loadAllRows();
  const domains = refreshed
    .filter((r) => r.schema_name === schema)
    .map(rowToDomainInfo);

  return {
    status: "pending_validation",
    validation_records: validationRecords,
    email_records: emailRecords,
    domains,
  };
}

export async function checkCustomDomains(schema: string): Promise<{
  status: "no_pending" | "pending_validation" | "active";
  distribution_domain: string;
  domains: DomainInfo[];
  email_records: EmailRecord[];
}> {
  await ensureTable();

  const allRows = await loadAllRows();
  const pendingArn = allRows.find((r) => r.pending_cert_arn)?.pending_cert_arn;

  if (!pendingArn) {
    // No frontend work in flight — still poll Postmark for this schema's
    // pending email signatures. This lets the agent call check-custom-
    // domains repeatedly to flip email_status from pending_verification to
    // active once the user's DNS is live, without touching the ACM flow.
    await pollPostmarkVerificationFor(schema, allRows);
    const refreshed = await loadAllRows();
    const emailRecords = await emailRecordsFromRows(
      refreshed.filter(
        (r) =>
          r.schema_name === schema &&
          r.postmark_domain_id !== null &&
          r.email_status !== "active" &&
          r.email_status !== "removed"
      )
    );
    return {
      status: "no_pending",
      distribution_domain: cfDomain(),
      domains: refreshed
        .filter((r) => r.schema_name === schema)
        .map(rowToDomainInfo),
      email_records: emailRecords,
    };
  }

  // Check ACM cert status
  const certStatus = await describeCertStatus(pendingArn);
  if (certStatus !== "ISSUED") {
    // ACM still pending — still useful to poll Postmark in the same tick so
    // the agent's single check call advances both fronts.
    await pollPostmarkVerificationFor(schema, allRows);
    const refreshed = await loadAllRows();
    const emailRecords = await emailRecordsFromRows(
      refreshed.filter(
        (r) =>
          r.schema_name === schema &&
          r.postmark_domain_id !== null &&
          r.email_status !== "active" &&
          r.email_status !== "removed"
      )
    );
    return {
      status: "pending_validation",
      distribution_domain: cfDomain(),
      domains: refreshed
        .filter(
          (r) =>
            r.schema_name === schema &&
            (r.status !== "pending_removal" || r.pending_cert_arn === pendingArn)
        )
        .map(rowToDomainInfo),
      email_records: emailRecords,
    };
  }

  // Cert issued — promote to live.
  const oldArn = await readCurrentCertArn();

  // Final live set = everything NOT in pending_removal. Always keep the
  // wildcard alias so the default `{app}.{customDomain}` subdomain keeps
  // terminating TLS on CloudFront. CloudFront only accepts requests for hosts
  // explicitly listed in Aliases — a missing wildcard breaks every app's
  // default subdomain URL.
  const finalLiveRows = allRows.filter((r) => r.status !== "pending_removal");
  const finalAliases = [
    `*.${customDomain()}`,
    ...finalLiveRows.map((r) => r.domain),
  ];

  // Build domainMap. Non-canonical rows emit a redirect entry pointing at the
  // schema's canonical host; canonical rows (or rows with no canonical yet —
  // legacy pre-canonical rows) emit a route entry carrying the schema name.
  const domainMap: DomainMap = {};
  for (const r of finalLiveRows) {
    if (r.canonical_domain && r.canonical_domain !== r.domain) {
      domainMap[r.domain] = { r: r.canonical_domain };
    } else {
      domainMap[r.domain] = { s: r.schema_name };
    }
  }

  // 1. UpdateDistribution — swap cert ARN + aliases
  const { distribution, etag } = await getDistributionState();
  if (!distribution.DistributionConfig) {
    throw new CustomDomainError(
      "CLOUDFRONT_UPDATE_FAILED",
      "Distribution config missing"
    );
  }
  const newConfig = structuredClone(distribution.DistributionConfig);
  newConfig.Aliases = {
    Quantity: finalAliases.length,
    Items: finalAliases.length > 0 ? finalAliases : undefined,
  };
  newConfig.ViewerCertificate = {
    ...(newConfig.ViewerCertificate ?? {}),
    ACMCertificateArn: pendingArn,
    SSLSupportMethod: "sni-only",
    MinimumProtocolVersion:
      newConfig.ViewerCertificate?.MinimumProtocolVersion ?? "TLSv1.2_2021",
    CloudFrontDefaultCertificate: false,
  };
  await cf().send(
    new UpdateDistributionCommand({
      Id: distributionId(),
      IfMatch: etag,
      DistributionConfig: newConfig,
    })
  );

  // 2. Regenerate CF function with new domainMap
  const funcDesc = await cf().send(
    new DescribeFunctionCommand({ Name: cfFunctionName() })
  );
  const funcEtag = funcDesc.ETag;
  const funcStage = funcDesc.FunctionSummary?.FunctionConfig?.Runtime ?? "cloudfront-js-2.0";
  const funcComment =
    funcDesc.FunctionSummary?.FunctionConfig?.Comment ??
    "Hereya subdomain + custom-domain router";
  const funcCode = renderCloudFrontFunction(customDomain(), domainMap);
  const encoder = new TextEncoder();
  const updated = await cf().send(
    new UpdateFunctionCommand({
      Name: cfFunctionName(),
      IfMatch: funcEtag!,
      FunctionCode: encoder.encode(funcCode),
      FunctionConfig: {
        Comment: funcComment,
        Runtime: funcStage,
      },
    })
  );
  await cf().send(
    new PublishFunctionCommand({
      Name: cfFunctionName(),
      IfMatch: updated.ETag!,
    })
  );

  // 3. Persist new cert ARN to SSM (single source of truth for CDK)
  await writeCurrentCertArn(pendingArn);

  // 4a. Tear down Postmark signatures for rows being removed BEFORE we drop
  //     the DB rows (we need the postmark_domain_id).
  for (const r of allRows) {
    if (r.status === "pending_removal" && r.postmark_domain_id) {
      await postmarkDeleteDomain(r.postmark_domain_id).catch(() => undefined);
    }
  }

  // 4. DB: promote pending rows, delete removed rows
  await sql(
    `UPDATE public._custom_domains
     SET status = 'active', cert_arn = pending_cert_arn, pending_cert_arn = NULL, updated_at = NOW()
     WHERE pending_cert_arn = :arn`,
    convertParams({ arn: pendingArn })
  );
  await sql(`DELETE FROM public._custom_domains WHERE status = 'pending_removal'`);

  // 5. Delete old cert (best-effort — CloudFront is propagating, but ACM allows delete once dissociated)
  if (oldArn && oldArn !== pendingArn) {
    await deleteCertificateQuiet(oldArn);
  }

  // 6. Poll Postmark for any pending_verification signatures and flip to
  //    active if verified. This is a best-effort single-shot check — the
  //    user may not have added DNS yet, in which case they re-call us later.
  const afterSwap = await loadAllRows();
  await pollPostmarkVerificationFor(schema, afterSwap);

  const finalRows = await loadAllRows();
  const finalEmailRecords = await emailRecordsFromRows(
    finalRows.filter(
      (r) =>
        r.schema_name === schema &&
        r.postmark_domain_id !== null &&
        r.email_status !== "active" &&
        r.email_status !== "removed"
    )
  );
  return {
    status: "active",
    distribution_domain: cfDomain(),
    domains: finalRows
      .filter((r) => r.schema_name === schema)
      .map(rowToDomainInfo),
    email_records: finalEmailRecords,
  };
}

// ---------------------------------------------------------------------------
// Postmark polling + record-assembly helpers used by checkCustomDomains
// ---------------------------------------------------------------------------

// For each row in this schema with email_status = 'pending_verification',
// ask Postmark whether both DKIM and ReturnPath are verified. On success,
// flip the DB row to 'active'. This is called opportunistically from
// checkCustomDomains on every invocation; no blocking.
async function pollPostmarkVerificationFor(
  schema: string,
  rows: DomainRow[]
): Promise<void> {
  for (const r of rows) {
    if (
      r.schema_name !== schema ||
      r.email_status !== "pending_verification" ||
      !r.postmark_domain_id
    ) {
      continue;
    }
    try {
      // Nudge Postmark to re-check DNS first, then read status.
      await postmarkVerifyDomain(r.postmark_domain_id).catch(() => undefined);
      const verified = await postmarkIsDomainVerified(r.postmark_domain_id);
      if (verified) {
        await sql(
          `UPDATE public._custom_domains
           SET email_status = 'active', updated_at = NOW()
           WHERE domain = :d`,
          convertParams({ d: r.domain })
        );
      }
    } catch (err) {
      console.error(
        `[check-custom-domains] Postmark verify poll failed for ${r.domain}:`,
        err
      );
    }
  }
}

// Load DKIM + return-path records from Postmark for each row's postmark
// domain id and flatten to EmailRecord[]. Used to return actionable DNS the
// agent can relay to the user.
async function emailRecordsFromRows(
  rows: DomainRow[]
): Promise<EmailRecord[]> {
  const records: EmailRecord[] = [];
  for (const r of rows) {
    if (!r.postmark_domain_id) continue;
    try {
      const pm = await postmarkGetDomain(r.postmark_domain_id);
      records.push(...postmarkRecords(pm));
    } catch (err) {
      console.error(
        `[check-custom-domains] Postmark getDomain failed for ${r.domain}:`,
        err
      );
    }
  }
  return records;
}

export async function listCustomDomains(
  schemaFilter?: string
): Promise<DomainInfo[]> {
  await ensureTable();
  const rows = await loadAllRows();
  const filtered = schemaFilter
    ? rows.filter((r) => r.schema_name === schemaFilter)
    : rows;
  return filtered.map(rowToDomainInfo);
}
