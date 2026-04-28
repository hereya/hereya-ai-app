import {
  SSMClient,
  GetParameterCommand,
  PutParameterCommand,
  DeleteParameterCommand,
  ParameterNotFound,
} from "@aws-sdk/client-ssm";

// ---------------------------------------------------------------------------
// SSM wrapper used by the org Lambda to manage per-app agent secrets.
// Secrets live at /hereya/{organizationId}/apps/{schema}/agent-secret — see
// src/app-lambda.ts for the path builder. This module is not used by per-app
// Lambdas (they have their own reader in src/runtime/ssm.ts).
// ---------------------------------------------------------------------------

const client = new SSMClient({ region: process.env.awsRegion });

// In-memory cache with a 60s TTL so rotations propagate quickly but we don't
// hammer SSM on every bootstrap mint.
const cache = new Map<string, { value: string; expiresAt: number }>();
const CACHE_TTL_MS = 60_000;

export async function getParameter(path: string): Promise<string | null> {
  const hit = cache.get(path);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  try {
    const result = await client.send(
      new GetParameterCommand({ Name: path, WithDecryption: true })
    );
    const value = result.Parameter?.Value;
    if (!value) return null;
    cache.set(path, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value;
  } catch (err: any) {
    if (err instanceof ParameterNotFound || err?.name === "ParameterNotFound") {
      return null;
    }
    throw err;
  }
}

export async function putParameter(
  path: string,
  value: string,
  { overwrite = false }: { overwrite?: boolean } = {}
): Promise<void> {
  await client.send(
    new PutParameterCommand({
      Name: path,
      Value: value,
      Type: "SecureString",
      Overwrite: overwrite,
    })
  );
  cache.set(path, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

export async function deleteParameter(path: string): Promise<void> {
  try {
    await client.send(new DeleteParameterCommand({ Name: path }));
  } catch (err: any) {
    if (err instanceof ParameterNotFound || err?.name === "ParameterNotFound") {
      // already gone — idempotent
    } else {
      throw err;
    }
  }
  cache.delete(path);
}

export function invalidateCache(path: string): void {
  cache.delete(path);
}
