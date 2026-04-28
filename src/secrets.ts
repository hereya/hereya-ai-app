import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

let resolved = false;

export async function resolveSecrets(): Promise<void> {
  if (resolved) return;

  const secretKeys = process.env.SECRET_KEYS;
  if (!secretKeys) {
    resolved = true;
    return;
  }

  const client = new SecretsManagerClient({});
  const keys = secretKeys.split(",");

  await Promise.all(
    keys.map(async (key) => {
      const secretName = process.env[key];
      if (!secretName) return;

      const result = await client.send(
        new GetSecretValueCommand({ SecretId: secretName })
      );
      if (result.SecretString) {
        process.env[key] = result.SecretString;
      }
    })
  );

  resolved = true;
}
