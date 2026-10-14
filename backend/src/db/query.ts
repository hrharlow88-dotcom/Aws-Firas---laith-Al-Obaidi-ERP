import { QueryTypes, Transaction } from 'sequelize';
import { sequelize } from '../models';

type Params = Record<string, unknown>;

/**
 * Parameterized SELECT. Values are always passed as named replacements
 * (:name), never interpolated, so user input cannot alter the SQL.
 */
export async function select<T>(sql: string, params: Params = {}, transaction?: Transaction | null): Promise<T[]> {
  const rows = await sequelize.query(sql, {
    replacements: params,
    type: QueryTypes.SELECT,
    ...(transaction ? { transaction } : {}),
  });
  return rows as T[];
}

export async function selectOne<T>(sql: string, params: Params = {}, transaction?: Transaction | null): Promise<T | null> {
  const rows = await select<T>(sql, params, transaction);
  return rows[0] ?? null;
}

/** INSERT/UPDATE/DELETE, optionally with RETURNING. */
export async function execute<T = unknown>(sql: string, params: Params = {}, transaction?: Transaction | null): Promise<T[]> {
  const [rows] = await sequelize.query(sql, {
    replacements: params,
    ...(transaction ? { transaction } : {}),
  });
  return rows as T[];
}

export function transaction<T>(work: (transaction: Transaction) => Promise<T>): Promise<T> {
  return sequelize.transaction(work);
}

/**
 * Inserts one row. Only fields present in `columns` are written, so the
 * column names in the SQL always come from code, never from the request.
 */
export async function insertRow(
  table: string,
  values: Record<string, unknown>,
  columns: Record<string, string>,
  transaction?: Transaction | null,
): Promise<void> {
  const fields = Object.keys(values).filter((field) => values[field] !== undefined && columns[field]);
  const params: Params = {};
  for (const field of fields) params[`ins_${field}`] = values[field];
  await execute(
    `INSERT INTO ${table} (${fields.map((field) => columns[field]).join(', ')})
     VALUES (${fields.map((field) => `:ins_${field}`).join(', ')})`,
    params,
    transaction,
  );
}

/** Builds a partial UPDATE's SET clause from a field → column map. */
export function setClause(values: Record<string, unknown>, columns: Record<string, string>): { sql: string; params: Params } {
  const parts: string[] = [];
  const params: Params = {};
  for (const [field, value] of Object.entries(values)) {
    if (value === undefined) continue;
    const column = columns[field];
    if (!column) continue;
    parts.push(`${column} = :set_${field}`);
    params[`set_${field}`] = value;
  }
  return { sql: parts.join(', '), params };
}
