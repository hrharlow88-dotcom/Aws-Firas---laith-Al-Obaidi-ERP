/**
 * For the screen check only: session tokens for the owner and one employee of
 * the e2e copy (made-up data). Adds a portal account for the first employee if
 * none exists, and marks both active so the idle sign-out lets them in.
 * Refuses any database whose name does not contain "e2e".
 *
 *   DB_NAME=laith_erp_e2e JWT_SECRET=… node tokens.mjs > tokens.json
 */
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const require = createRequire(new URL('../backend/package.json', import.meta.url));
const { Client } = require('pg');
const jwt = require('jsonwebtoken');

const database = process.env.DB_NAME || '';
if (!/e2e/.test(database)) throw new Error('Refusing: the screen check only runs on a database whose name contains "e2e".');
const db = new Client({
  host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 5432), database,
  user: process.env.DB_USER || 'erp', password: process.env.DB_PASSWORD || 'erp_dev_pw',
});
await db.connect();
const owner = (await db.query("SELECT id, token_version FROM users WHERE role = 'super_admin' AND is_active ORDER BY created_at LIMIT 1")).rows[0];
let employee = (await db.query("SELECT id, token_version, employee_id FROM users WHERE role = 'employee' AND is_active AND employee_id IS NOT NULL LIMIT 1")).rows[0];
if (!employee) {
  const person = (await db.query("SELECT id FROM employees WHERE employment_status = 'active' ORDER BY employee_no LIMIT 1")).rows[0];
  const id = randomUUID();
  await db.query(
    `INSERT INTO users (id, name, email, password_hash, role, is_active, token_version, employee_id, failed_logins, created_at, updated_at)
     VALUES ($1, 'موظف الفحص', $2, '!', 'employee', true, 0, $3, 0, now(), now())`,
    [id, `e2e.${id.slice(0, 8)}@e2e.local`, person.id],
  );
  employee = { id, token_version: 0, employee_id: person.id };
}
await db.query('UPDATE users SET last_seen_at = now() WHERE id = ANY($1::uuid[])', [[owner.id, employee.id]]);
const run = (await db.query("SELECT id FROM payroll_runs WHERE status <> 'cancelled' ORDER BY created_at DESC LIMIT 1")).rows[0];
await db.end();
const sign = (user) => jwt.sign({ sub: user.id, ver: user.token_version }, process.env.JWT_SECRET, { expiresIn: '2h' });
console.log(JSON.stringify({ owner: sign(owner), employee: sign(employee), employeeId: employee.employee_id, runId: run?.id ?? null }));
