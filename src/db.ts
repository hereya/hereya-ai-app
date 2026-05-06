import {
  RDSDataClient,
  ExecuteStatementCommand,
  type ExecuteStatementCommandOutput,
  BatchExecuteStatementCommand,
  type BatchExecuteStatementCommandOutput,
  BeginTransactionCommand,
  type BeginTransactionCommandOutput,
  CommitTransactionCommand,
  type CommitTransactionCommandOutput,
  RollbackTransactionCommand,
  type RollbackTransactionCommandOutput,
  type SqlParameter,
  type Field,
} from "@aws-sdk/client-rds-data";
import { sendWithResumeRetry } from "./retry.js";

const client = new RDSDataClient({ region: process.env.awsRegion });

const clusterArn = () => process.env.clusterArn!;
const secretArn = () => process.env.secretArn!;
const databaseName = () => process.env.databaseName!;

// ---------------------------------------------------------------------------
// Identifier validation
// ---------------------------------------------------------------------------

const IDENT_RE = /^[a-z_][a-z0-9_]{0,62}$/i;

export function isValidIdentifier(name: string): boolean {
  return IDENT_RE.test(name);
}

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

// ---------------------------------------------------------------------------
// Parameter conversion
// ---------------------------------------------------------------------------
// Converts a simple { key: value } object into Data API SqlParameter[] format.
// Type inference: string→stringValue, integer→longValue, float→doubleValue,
// boolean→booleanValue, null/undefined→isNull.
// ---------------------------------------------------------------------------

export function convertParams(
  params: Record<string, unknown>
): SqlParameter[] {
  return Object.entries(params).map(([name, val]) => {
    if (val === null || val === undefined) {
      return { name, value: { isNull: true } };
    }
    if (typeof val === "string") {
      return { name, value: { stringValue: val } };
    }
    if (typeof val === "boolean") {
      return { name, value: { booleanValue: val } };
    }
    if (typeof val === "number") {
      if (Number.isInteger(val)) {
        return { name, value: { longValue: val } };
      }
      return { name, value: { doubleValue: val } };
    }
    // Fallback: serialize as string
    return { name, value: { stringValue: String(val) } };
  });
}

// ---------------------------------------------------------------------------
// SQL safety guard
// ---------------------------------------------------------------------------

const FORBIDDEN_RE = /\b(DROP\s+SCHEMA|DROP\s+DATABASE)\b/i;

export function assertSafeSql(statement: string): void {
  if (FORBIDDEN_RE.test(statement)) {
    throw new ForbiddenOperationError(
      "DROP SCHEMA and DROP DATABASE are not allowed via execute. Use the drop-schema primitive instead."
    );
  }
}

export class ForbiddenOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForbiddenOperationError";
  }
}

// ---------------------------------------------------------------------------
// Core SQL execution
// ---------------------------------------------------------------------------

export async function sql(query: string, params?: SqlParameter[]) {
  return sendWithResumeRetry<ExecuteStatementCommandOutput>(
    client,
    new ExecuteStatementCommand({
      resourceArn: clusterArn(),
      secretArn: secretArn(),
      database: databaseName(),
      sql: query,
      parameters: params,
    })
  );
}

export async function sqlWithMetadata(
  query: string,
  params?: SqlParameter[]
) {
  return sendWithResumeRetry<ExecuteStatementCommandOutput>(
    client,
    new ExecuteStatementCommand({
      resourceArn: clusterArn(),
      secretArn: secretArn(),
      database: databaseName(),
      sql: query,
      parameters: params,
      includeResultMetadata: true,
    })
  );
}

// ---------------------------------------------------------------------------
// Field value extraction
// ---------------------------------------------------------------------------

export function extractFieldValue(field: Field): unknown {
  if (field.isNull) return null;
  if (field.stringValue !== undefined) return field.stringValue;
  if (field.longValue !== undefined) return field.longValue;
  if (field.doubleValue !== undefined) return field.doubleValue;
  if (field.booleanValue !== undefined) return field.booleanValue;
  if (field.blobValue !== undefined) return "<blob>";
  if (field.arrayValue !== undefined) return field.arrayValue;
  return null;
}

// ---------------------------------------------------------------------------
// Batch insert
// ---------------------------------------------------------------------------
// Constructs INSERT INTO ... VALUES (...) for each row, using
// BatchExecuteStatementCommand. Chunks into batches of 500 rows.
// Wraps all batches in a single transaction for atomicity.
// ---------------------------------------------------------------------------

export async function batchInsert(
  schema: string,
  table: string,
  columns: string[],
  rows: unknown[][]
): Promise<number> {
  const qualifiedTable = `${quoteIdent(schema)}.${quoteIdent(table)}`;
  const quotedCols = columns.map(quoteIdent).join(", ");

  // Build the parameterized SQL template
  // Each row gets params named col0, col1, col2, ...
  const placeholders = columns.map((_, i) => `:col${i}`).join(", ");
  const insertSql = `INSERT INTO ${qualifiedTable} (${quotedCols}) VALUES (${placeholders})`;

  // Convert rows into parameter sets
  const parameterSets: SqlParameter[][] = rows.map((row) =>
    row.map((val, i) => {
      const name = `col${i}`;
      if (val === null || val === undefined) {
        return { name, value: { isNull: true } };
      }
      if (typeof val === "string") {
        return { name, value: { stringValue: val } };
      }
      if (typeof val === "boolean") {
        return { name, value: { booleanValue: val } };
      }
      if (typeof val === "number") {
        if (Number.isInteger(val)) {
          return { name, value: { longValue: val } };
        }
        return { name, value: { doubleValue: val } };
      }
      return { name, value: { stringValue: String(val) } };
    })
  );

  // Chunk into batches of 500
  const CHUNK_SIZE = 500;
  const chunks: SqlParameter[][][] = [];
  for (let i = 0; i < parameterSets.length; i += CHUNK_SIZE) {
    chunks.push(parameterSets.slice(i, i + CHUNK_SIZE));
  }

  // Execute all chunks in a transaction
  const txn = await sendWithResumeRetry<BeginTransactionCommandOutput>(
    client,
    new BeginTransactionCommand({
      resourceArn: clusterArn(),
      secretArn: secretArn(),
      database: databaseName(),
    })
  );
  const transactionId = txn.transactionId!;

  try {
    let totalInserted = 0;
    for (const chunk of chunks) {
      const result = await sendWithResumeRetry<BatchExecuteStatementCommandOutput>(
        client,
        new BatchExecuteStatementCommand({
          resourceArn: clusterArn(),
          secretArn: secretArn(),
          database: databaseName(),
          transactionId,
          sql: insertSql,
          parameterSets: chunk,
        })
      );
      // Each update result in the array corresponds to one row
      totalInserted += result.updateResults?.length ?? chunk.length;
    }

    await sendWithResumeRetry<CommitTransactionCommandOutput>(
      client,
      new CommitTransactionCommand({
        resourceArn: clusterArn(),
        secretArn: secretArn(),
        transactionId,
      })
    );

    return totalInserted;
  } catch (err) {
    await sendWithResumeRetry<RollbackTransactionCommandOutput>(
      client,
      new RollbackTransactionCommand({
        resourceArn: clusterArn(),
        secretArn: secretArn(),
        transactionId,
      })
    ).catch(() => {}); // Best effort rollback
    throw err;
  }
}
