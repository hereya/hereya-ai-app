import { sql } from "./db.js";

export interface ColumnInfo {
  name: string;
  type: string;
  primary_key?: boolean;
  foreign_key?: string;
  nullable?: boolean;
  default?: string;
}

export interface TableInfo {
  name: string;
  columns: ColumnInfo[];
}

/**
 * Returns the full structure of a schema: tables with columns, types, constraints.
 * Returns null if the schema does not exist.
 */
export async function describeSchemaStructure(
  schema: string
): Promise<{ schema: string; tables: TableInfo[] } | null> {
  // Check schema exists
  const schemaCheck = await sql(
    `SELECT 1 FROM information_schema.schemata WHERE schema_name = :name`,
    [{ name: "name", value: { stringValue: schema } }]
  );
  if (!schemaCheck.records?.length) {
    return null;
  }

  // Get all columns
  const colResult = await sql(
    `SELECT table_name, column_name, data_type, character_maximum_length,
            numeric_precision, numeric_scale, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = :schema
     ORDER BY table_name, ordinal_position`,
    [{ name: "schema", value: { stringValue: schema } }]
  );

  // Get primary keys
  const pkResult = await sql(
    `SELECT tc.table_name, kcu.column_name
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema = kcu.table_schema
     WHERE tc.table_schema = :schema AND tc.constraint_type = 'PRIMARY KEY'`,
    [{ name: "schema", value: { stringValue: schema } }]
  );

  // Get foreign keys
  const fkResult = await sql(
    `SELECT kcu.table_name, kcu.column_name,
            ccu.table_schema || '.' || ccu.table_name || '.' || ccu.column_name AS references_column
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema = kcu.table_schema
     JOIN information_schema.constraint_column_usage ccu
       ON tc.constraint_name = ccu.constraint_name
       AND tc.table_schema = ccu.table_schema
     WHERE tc.table_schema = :schema AND tc.constraint_type = 'FOREIGN KEY'`,
    [{ name: "schema", value: { stringValue: schema } }]
  );

  // Build PK lookup
  const pkSet = new Set<string>();
  for (const row of pkResult.records ?? []) {
    pkSet.add(`${row[0].stringValue}.${row[1].stringValue}`);
  }

  // Build FK lookup
  const fkMap = new Map<string, string>();
  for (const row of fkResult.records ?? []) {
    fkMap.set(
      `${row[0].stringValue}.${row[1].stringValue}`,
      row[2].stringValue!
    );
  }

  // Group columns by table
  const tablesMap = new Map<string, ColumnInfo[]>();
  for (const row of colResult.records ?? []) {
    const tableName = row[0].stringValue!;
    const columnName = row[1].stringValue!;
    const dataType = row[2].stringValue!;
    const charMaxLen = row[3].isNull ? null : row[3].longValue;
    const nullable = row[6].stringValue === "YES";
    const defaultVal = row[7].isNull ? null : row[7].stringValue;
    const key = `${tableName}.${columnName}`;

    let fullType = dataType;
    if (charMaxLen) fullType = `${dataType}(${charMaxLen})`;

    const col: ColumnInfo = {
      name: columnName,
      type: fullType,
    };
    if (pkSet.has(key)) col.primary_key = true;
    if (fkMap.has(key)) col.foreign_key = fkMap.get(key);
    if (!nullable) col.nullable = false;
    if (defaultVal) col.default = defaultVal;

    if (!tablesMap.has(tableName)) tablesMap.set(tableName, []);
    tablesMap.get(tableName)!.push(col);
  }

  const tables = Array.from(tablesMap.entries()).map(([name, columns]) => ({
    name,
    columns,
  }));

  return { schema, tables };
}
