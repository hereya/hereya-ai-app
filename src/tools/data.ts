import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  sql,
  sqlWithMetadata,
  convertParams,
  assertSafeSql,
  extractFieldValue,
  isValidIdentifier,
  batchInsert,
  ForbiddenOperationError,
} from "../db.js";
import { toolError, dbErrorToToolError } from "../errors.js";
import { DatabaseResumingError } from "../retry.js";

export function registerDataTools(server: McpServer) {
  // --- execute ---
  server.registerTool(
    "execute",
    {
      title: "Execute SQL",
      description:
        "Execute any SQL statement: CREATE TABLE, ALTER TABLE, INSERT, UPDATE, DELETE, etc. Use parameterized queries with :param_name syntax. Cannot DROP SCHEMA (use drop-schema primitive instead).",
      inputSchema: {
        sql: z
          .string()
          .describe("SQL statement with optional :param_name placeholders"),
        params: z
          .record(z.unknown())
          .optional()
          .describe("Key-value pairs for parameterized values"),
      },
    },
    async ({ sql: statement, params }) => {
      try {
        assertSafeSql(statement);
      } catch (err) {
        if (err instanceof ForbiddenOperationError) {
          return toolError("FORBIDDEN_OPERATION", err.message);
        }
        throw err;
      }

      try {
        const parameters = params ? convertParams(params) : undefined;
        const result = await sql(statement, parameters);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                rows_affected: result.numberOfRecordsUpdated ?? 0,
              }),
            },
          ],
        };
      } catch (err: any) {
        return dbErrorToToolError(err);
      }
    }
  );

  // --- query ---
  server.registerTool(
    "query",
    {
      title: "Query SQL",
      description:
        "Execute a SELECT query and return rows. Max 1000 rows per query — use LIMIT/OFFSET for pagination. Supports cross-schema joins.",
      inputSchema: {
        sql: z
          .string()
          .describe("SELECT statement with optional :param_name placeholders"),
        params: z
          .record(z.unknown())
          .optional()
          .describe("Key-value pairs for parameterized values"),
      },
    },
    async ({ sql: statement, params }) => {
      // Validate it's a read query
      const trimmed = statement.trim().toUpperCase();
      if (!trimmed.startsWith("SELECT") && !trimmed.startsWith("WITH")) {
        return toolError(
          "SQL_ERROR",
          "query only accepts SELECT or WITH statements. Use execute for DDL/DML."
        );
      }

      try {
        const parameters = params ? convertParams(params) : undefined;
        const result = await sqlWithMetadata(statement, parameters);

        // Extract column names from metadata
        const columns =
          result.columnMetadata?.map((col) => col.name ?? "?") ?? [];

        // Extract rows
        const rows = (result.records ?? []).map((record) =>
          record.map(extractFieldValue)
        );

        if (rows.length > 1000) {
          return toolError(
            "RESULT_TOO_LARGE",
            `Query returned ${rows.length} rows. Maximum is 1000. Add a LIMIT clause.`
          );
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                columns,
                rows,
                row_count: rows.length,
              }),
            },
          ],
        };
      } catch (err: any) {
        return dbErrorToToolError(err);
      }
    }
  );

  // --- bulk-insert ---
  server.registerTool(
    "bulk-insert",
    {
      title: "Bulk Insert",
      description:
        "Insert many rows at once. Use this instead of multiple individual inserts — especially when importing data from Excel or CSV. Max 10,000 rows per call.",
      inputSchema: {
        schema: z.string().describe("Target schema"),
        table: z.string().describe("Target table"),
        columns: z
          .array(z.string())
          .describe("Column names to insert"),
        rows: z
          .array(z.array(z.unknown()))
          .describe("Array of arrays, each inner array is one row's values"),
      },
    },
    async ({ schema, table, columns, rows }) => {
      // Validate identifiers
      if (!isValidIdentifier(schema)) {
        return toolError("INVALID_NAME", `Invalid schema name: "${schema}"`);
      }
      if (!isValidIdentifier(table)) {
        return toolError("INVALID_NAME", `Invalid table name: "${table}"`);
      }
      for (const col of columns) {
        if (!isValidIdentifier(col)) {
          return toolError("INVALID_NAME", `Invalid column name: "${col}"`);
        }
      }

      // Validate payload size
      if (rows.length === 0) {
        return toolError("SQL_ERROR", "No rows to insert");
      }
      if (rows.length > 10000) {
        return toolError(
          "PAYLOAD_TOO_LARGE",
          `${rows.length} rows exceeds the 10,000 row limit`
        );
      }

      // Validate row widths match column count
      for (let i = 0; i < rows.length; i++) {
        if (rows[i].length !== columns.length) {
          return toolError(
            "SQL_ERROR",
            `Row ${i} has ${rows[i].length} values but ${columns.length} columns were specified`
          );
        }
      }

      try {
        const inserted = await batchInsert(schema, table, columns, rows);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ rows_inserted: inserted }),
            },
          ],
        };
      } catch (err: any) {
        if (err instanceof DatabaseResumingError) {
          return toolError("DATABASE_RESUMING", err.message);
        }
        const message = err.message ?? String(err);
        if (message.includes("relation") && message.includes("does not exist")) {
          return toolError("TABLE_NOT_FOUND", message);
        }
        return toolError("SQL_ERROR", message);
      }
    }
  );
}
