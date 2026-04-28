import {
  SSMClient,
  GetParameterCommand,
  ParameterNotFound,
} from "@aws-sdk/client-ssm";

// ---------------------------------------------------------------------------
// Per-app Lambda's read-only view of SSM. Used to fetch the agent-session
// signing secret at cold start. The path is supplied via the
// AGENT_SECRET_SSM_PATH env var (set by the org Lambda when creating the
// per-app Lambda). Cached for the lifetime of the container — rotations force
// a container recycle via a separate env var bump.
// ---------------------------------------------------------------------------

const client = new SSMClient({ region: process.env.awsRegion });

let cached: string | null | undefined;

export async function getAgentSecret(): Promise<string | null> {
  if (cached !== undefined) return cached;
  const path = process.env.AGENT_SECRET_SSM_PATH;
  if (!path) {
    cached = null;
    return null;
  }
  try {
    const result = await client.send(
      new GetParameterCommand({ Name: path, WithDecryption: true })
    );
    cached = result.Parameter?.Value ?? null;
    return cached;
  } catch (err: any) {
    if (err instanceof ParameterNotFound || err?.name === "ParameterNotFound") {
      cached = null;
      return null;
    }
    throw err;
  }
}
