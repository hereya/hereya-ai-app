import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { isValidIdentifier, sql } from "../db.js";
import { toolError } from "../errors.js";
import { getAppAuthStatus } from "../app-auth.js";
import { ensureCustomDomainsTable } from "../custom-domain.js";
import { getParameter } from "../ssm.js";
import {
  sendEmail as postmarkSendEmail,
  postmarkStreamId,
  type PostmarkStream,
} from "../postmark.js";

// ---------------------------------------------------------------------------
// Sender composition — the domain is fixed to the app's signed subdomain.
// Callers pick a display name and a local-part; everything else (@domain) is
// derived from the app to keep Postmark deliverability + prevent cross-app
// impersonation.
// ---------------------------------------------------------------------------

const LOCAL_PART_RE = /^[a-z0-9._+-]{1,64}$/i;

function organizationId(): string {
  return process.env.ORGANIZATION_ID!;
}

function postmarkServerTokenSsmPath(schema: string): string {
  return `/hereya/${organizationId()}/apps/${schema}/auth/postmark-server-token`;
}

export function registerMailTools(server: McpServer) {
  server.registerTool(
    "send-mail",
    {
      title: "Send Mail",
      description:
        "Send an email from the app's per-app Postmark server. Requires enable-auth. By default the From domain is the app's signed internal subdomain ({schema}.{customDomain}); pass `from_domain` to send from a verified custom domain (must be active in `_custom_domains` with email_status='active'). The local-part and display name are configurable. Use stream='transactional' (default) for 1:1 user-triggered mail, or stream='broadcast' for bulk/marketing sends — picking the wrong stream damages deliverability.",
      inputSchema: {
        schema: z.string().describe("App schema to send mail on behalf of"),
        to: z.string().email().describe("Recipient email address"),
        subject: z.string().min(1).describe("Email subject line"),
        body_html: z.string().optional().describe("HTML body"),
        body_text: z.string().optional().describe("Plain-text body"),
        from_local_part: z
          .string()
          .optional()
          .describe(
            "Local part of the From address (before @). Defaults to 'noreply'. Allowed: [a-z0-9._+-], max 64 chars."
          ),
        from_name: z
          .string()
          .optional()
          .describe(
            "Display name for the From header. Defaults to the schema name."
          ),
        from_domain: z
          .string()
          .optional()
          .describe(
            "Verified custom domain to send from (e.g. 'acme.com'). Must be active in the schema's _custom_domains with email_status='active'. Omit to send from the default internal {schema}.{customDomain} sender."
          ),
        stream: z
          .enum(["transactional", "broadcast"])
          .optional()
          .describe(
            "Postmark message stream. 'transactional' (default) for 1:1 user mail; 'broadcast' for bulk."
          ),
      },
    },
    async ({
      schema,
      to,
      subject,
      body_html,
      body_text,
      from_local_part,
      from_name,
      from_domain,
      stream,
    }) => {
      if (!isValidIdentifier(schema)) {
        return toolError("INVALID_NAME", `Invalid schema name: "${schema}".`);
      }
      if (!body_html && !body_text) {
        return toolError(
          "INVALID_INPUT",
          "At least one of body_html / body_text is required."
        );
      }

      const localPart = from_local_part ?? "noreply";
      if (!LOCAL_PART_RE.test(localPart)) {
        return toolError(
          "INVALID_INPUT",
          `from_local_part must match [a-z0-9._+-]{1,64}; got "${localPart}".`
        );
      }

      const appAuth = await getAppAuthStatus(schema);
      if (!appAuth) {
        return toolError(
          "AUTH_NOT_ENABLED",
          `enable-auth has not been called for '${schema}'. Run it first.`
        );
      }

      const serverToken = await getParameter(postmarkServerTokenSsmPath(schema));
      if (!serverToken) {
        return toolError(
          "AUTH_STATE_DRIFT",
          `Postmark server token missing in SSM for '${schema}' — re-run enable-auth to repair.`
        );
      }

      // Pick the From domain. Default = the app's internal signed subdomain
      // ({schema}.{customDomain}); caller-supplied from_domain must match a
      // row in _custom_domains for this schema with email_status='active'.
      const defaultDomain = appAuth.from_email.split("@")[1];
      let fromDomain = defaultDomain;
      if (from_domain && from_domain !== defaultDomain) {
        await ensureCustomDomainsTable();
        const allowed = await sql(
          `SELECT 1 FROM public._custom_domains
            WHERE schema_name = :schema
              AND domain = :domain
              AND email_status = 'active'`,
          [
            { name: "schema", value: { stringValue: schema } },
            {
              name: "domain",
              value: { stringValue: from_domain.toLowerCase() },
            },
          ]
        );
        if (!allowed.records?.length) {
          return toolError(
            "INVALID_FROM_DOMAIN",
            `from_domain '${from_domain}' is not an active sender for '${schema}'. ` +
              `Add it via set-custom-domains, wait for email_status='active' after DNS verification, then retry.`
          );
        }
        fromDomain = from_domain.toLowerCase();
      }
      const displayName = (from_name ?? schema).replace(/"/g, "'");
      const from = `"${displayName}" <${localPart}@${fromDomain}>`;

      const pmStream: PostmarkStream = stream ?? "transactional";

      try {
        const result = await postmarkSendEmail(serverToken, {
          From: from,
          To: to,
          Subject: subject,
          HtmlBody: body_html,
          TextBody: body_text,
          MessageStream: postmarkStreamId(pmStream),
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                message_id: result.MessageID,
                submitted_at: result.SubmittedAt,
                to: result.To,
                from,
                stream: pmStream,
              }),
            },
          ],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return toolError("POSTMARK_ERROR", `send-mail failed: ${msg}`);
      }
    }
  );
}
