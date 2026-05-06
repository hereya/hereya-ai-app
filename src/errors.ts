import { DatabaseResumingError } from "./retry.js";

export function toolError(code: string, message: string) {
  return {
    isError: true as const,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ error: { code, message } }),
      },
    ],
  };
}

export function dbErrorToToolError(err: unknown) {
  if (err instanceof DatabaseResumingError) {
    return toolError("DATABASE_RESUMING", err.message);
  }
  const message = (err as { message?: string })?.message ?? String(err);
  return toolError("SQL_ERROR", message);
}
