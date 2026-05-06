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
// Parameter conversion
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
    return { name, value: { stringValue: String(val) } };
  });
}

// ---------------------------------------------------------------------------
// Field value extraction
// ---------------------------------------------------------------------------

function extractFieldValue(field: Field): unknown {
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
// SQL execution
// ---------------------------------------------------------------------------

export async function sql(queryStr: string, params?: SqlParameter[]) {
  return sendWithResumeRetry<ExecuteStatementCommandOutput>(
    client,
    new ExecuteStatementCommand({
      resourceArn: clusterArn(),
      secretArn: secretArn(),
      database: databaseName(),
      sql: queryStr,
      parameters: params,
    })
  );
}

// ---------------------------------------------------------------------------
// Query — returns { columns, rows, row_count }
// ---------------------------------------------------------------------------

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  row_count: number;
}

export async function query(
  queryStr: string,
  params?: SqlParameter[]
): Promise<QueryResult> {
  const result = await sendWithResumeRetry<ExecuteStatementCommandOutput>(
    client,
    new ExecuteStatementCommand({
      resourceArn: clusterArn(),
      secretArn: secretArn(),
      database: databaseName(),
      sql: queryStr,
      parameters: params,
      includeResultMetadata: true,
    })
  );

  const columns = result.columnMetadata?.map((c) => c.name ?? "?") ?? [];
  const rows = (result.records ?? []).map((record) => {
    const obj: Record<string, unknown> = {};
    columns.forEach((col, i) => {
      obj[col] = extractFieldValue(record[i]);
    });
    return obj;
  });

  return { columns, rows, row_count: rows.length };
}

// ---------------------------------------------------------------------------
// Batch insert
// ---------------------------------------------------------------------------

export async function batchInsert(
  schema: string,
  table: string,
  columns: string[],
  rows: unknown[][]
): Promise<number> {
  const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;
  const qualifiedTable = `${quoteIdent(schema)}.${quoteIdent(table)}`;
  const quotedCols = columns.map(quoteIdent).join(", ");
  const placeholders = columns.map((_, i) => `:col${i}`).join(", ");
  const insertSql = `INSERT INTO ${qualifiedTable} (${quotedCols}) VALUES (${placeholders})`;

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

  const CHUNK_SIZE = 500;
  const chunks: SqlParameter[][][] = [];
  for (let i = 0; i < parameterSets.length; i += CHUNK_SIZE) {
    chunks.push(parameterSets.slice(i, i + CHUNK_SIZE));
  }

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
    ).catch(() => {});
    throw err;
  }
}
