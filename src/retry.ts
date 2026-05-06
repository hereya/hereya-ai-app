import type { RDSDataClient } from "@aws-sdk/client-rds-data";

export class DatabaseResumingError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "DatabaseResumingError";
  }
}

const RESUMING_MSG_RE = /Communications link failure|is resuming|is being resumed/i;

export function isResumeError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; message?: string };
  if (e.name === "DatabaseResumingException") return true;
  if (e.name === "BadRequestException" && RESUMING_MSG_RE.test(String(e.message ?? ""))) return true;
  return false;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface RetryOptions {
  budgetMs?: number;
  baseMs?: number;
  capMs?: number;
}

export async function sendWithResumeRetry<TOutput>(
  client: RDSDataClient,
  command: unknown,
  opts: RetryOptions = {}
): Promise<TOutput> {
  const budgetMs = opts.budgetMs ?? 25_000;
  const baseMs = opts.baseMs ?? 750;
  const capMs = opts.capMs ?? 4_000;
  const deadline = Date.now() + budgetMs;
  let attempt = 0;
  // Cast preserves the SDK's per-command output typing at call sites.
  const send = () => client.send(command as any) as Promise<TOutput>;
  while (true) {
    try {
      return await send();
    } catch (err) {
      if (!isResumeError(err)) throw err;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new DatabaseResumingError(
          "Database is resuming after auto-pause. Retry in a few seconds.",
          err
        );
      }
      const backoff = Math.min(capMs, baseMs * 2 ** attempt);
      const jitter = Math.random() * 250;
      await sleep(Math.min(remaining, backoff + jitter));
      attempt++;
    }
  }
}
