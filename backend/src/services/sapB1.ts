import fs from 'node:fs';
import { Agent, fetch as undiciFetch } from 'undici';

/**
 * Minimal SAP Business One Service Layer client (OData v3/v4, /b1s/v1).
 * Credentials come only from the environment, never from the database:
 *   SAP_B1_URL           e.g. https://sap-server:50000/b1s/v1
 *   SAP_B1_COMPANY_DB    company database name
 *   SAP_B1_USER / SAP_B1_PASSWORD
 *   SAP_B1_CA_FILE       optional PEM of the Service Layer certificate
 *   SAP_B1_TLS_INSECURE  "true" only for a test system with a self-signed cert
 *   SAP_B1_LOCAL_CURRENCY company local currency in SAP (default IQD)
 */

export interface SapJournalLine {
  AccountCode: string;
  Debit?: number;
  Credit?: number;
  FCDebit?: number;
  FCCredit?: number;
  FCCurrency?: string;
  CostingCode?: string;
  LineMemo?: string;
}

export interface SapJournalEntry {
  ReferenceDate: string;
  TaxDate: string;
  DueDate: string;
  Memo: string;
  Reference: string;
  Reference2?: string;
  JournalEntryLines: SapJournalLine[];
}

export class SapError extends Error {
  constructor(message: string, public status: number, public retryable: boolean) {
    super(message);
    this.name = 'SapError';
  }
}

export function sapConfigured(): boolean {
  return Boolean(process.env.SAP_B1_URL && process.env.SAP_B1_COMPANY_DB && process.env.SAP_B1_USER && process.env.SAP_B1_PASSWORD);
}

export function sapLocalCurrency(): string {
  return (process.env.SAP_B1_LOCAL_CURRENCY || 'IQD').toUpperCase();
}

let dispatcher: Agent | null = null;
function agent(): Agent {
  if (!dispatcher) {
    const ca = process.env.SAP_B1_CA_FILE ? fs.readFileSync(process.env.SAP_B1_CA_FILE) : undefined;
    dispatcher = new Agent({
      connect: { ca, rejectUnauthorized: process.env.SAP_B1_TLS_INSECURE !== 'true' },
      headersTimeout: 60000,
      bodyTimeout: 60000,
    });
  }
  return dispatcher;
}

let session: { cookie: string; expiresAt: number } | null = null;

function baseUrl(): string {
  return (process.env.SAP_B1_URL || '').replace(/\/+$/, '');
}

function errorMessage(payload: unknown, status: number): string {
  const error = payload && typeof payload === 'object' && 'error' in payload ? (payload as { error: unknown }).error : null;
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
    if (message && typeof message === 'object' && 'value' in message) return String((message as { value: unknown }).value);
  }
  return `SAP Service Layer returned HTTP ${status}`;
}

async function login(): Promise<string> {
  let response;
  try {
    response = await undiciFetch(`${baseUrl()}/Login`, {
      method: 'POST',
      dispatcher: agent(),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        CompanyDB: process.env.SAP_B1_COMPANY_DB,
        UserName: process.env.SAP_B1_USER,
        Password: process.env.SAP_B1_PASSWORD,
      }),
    });
  } catch (error) {
    throw new SapError(`تعذر الاتصال بخادم SAP: ${error instanceof Error ? error.message : 'network error'}`, 0, true);
  }
  const payload = await response.json().catch(() => null) as { SessionId?: string; SessionTimeout?: number } | null;
  if (!response.ok || !payload?.SessionId) {
    throw new SapError(`فشل تسجيل الدخول إلى SAP: ${errorMessage(payload, response.status)}`, response.status, response.status >= 500);
  }
  // Keep B1SESSION and, behind the SAP load balancer, ROUTEID.
  const cookies = response.headers.getSetCookie().map((value) => value.split(';')[0])
    .filter((value) => /^(B1SESSION|ROUTEID)=/.test(value));
  const cookie = cookies.length ? cookies.join('; ') : `B1SESSION=${payload.SessionId}`;
  const minutes = Math.max(5, (payload.SessionTimeout || 30) - 5);
  session = { cookie, expiresAt: Date.now() + minutes * 60000 };
  return cookie;
}

async function request<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
  if (!sapConfigured()) throw new SapError('لم يُضبط الاتصال بـ SAP Business One على الخادم.', 0, false);
  const cookie = session && session.expiresAt > Date.now() ? session.cookie : await login();
  let response;
  try {
    response = await undiciFetch(`${baseUrl()}${path}`, {
      method,
      dispatcher: agent(),
      headers: {
        Cookie: cookie,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        // Return only what was asked for; keeps list calls small.
        Prefer: 'odata.maxpagesize=500',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch (error) {
    throw new SapError(`تعذر الاتصال بخادم SAP: ${error instanceof Error ? error.message : 'network error'}`, 0, true);
  }
  if (response.status === 401 && !retried) {
    session = null;
    return request<T>(method, path, body, true);
  }
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    // 4xx from SAP means the document was rejected (account, period, balance);
    // retrying the same document would fail again.
    throw new SapError(errorMessage(payload, response.status), response.status, response.status >= 500 || response.status === 429);
  }
  return payload as T;
}

function odataString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Finds an entry already posted with this reference (used to make retries idempotent). */
export async function findJournalByReference(reference: string): Promise<number | null> {
  const result = await request<{ value: Array<{ JdtNum: number }> }>(
    'GET',
    `/JournalEntries?$select=JdtNum&$filter=${encodeURIComponent(`Reference eq ${odataString(reference)}`)}`,
  );
  return result.value?.[0]?.JdtNum ?? null;
}

export async function createJournalEntry(entry: SapJournalEntry): Promise<number> {
  const created = await request<{ JdtNum: number }>('POST', '/JournalEntries', entry);
  if (!created?.JdtNum) throw new SapError('لم يُرجع SAP رقم القيد.', 500, true);
  return created.JdtNum;
}

export async function listAccounts(): Promise<Array<{ code: string; name: string }>> {
  const accounts: Array<{ code: string; name: string }> = [];
  let next: string | null = `/ChartOfAccounts?$select=Code,Name&$filter=${encodeURIComponent("ActiveAccount eq 'tYES'")}&$orderby=Code`;
  while (next && accounts.length < 20000) {
    const page: { value: Array<{ Code: string; Name: string }>; 'odata.nextLink'?: string; '@odata.nextLink'?: string } =
      await request('GET', next);
    accounts.push(...page.value.map((item) => ({ code: item.Code, name: item.Name })));
    const link = page['odata.nextLink'] || page['@odata.nextLink'];
    next = link ? `/${link.replace(/^.*\/b1s\/v\d\//, '').replace(/^\//, '')}` : null;
  }
  return accounts;
}

export async function listCostCenters(): Promise<Array<{ code: string; name: string; dimension: number }>> {
  const result = await request<{ value: Array<{ CenterCode: string; CenterName: string; InWhichDimension: number }> }>(
    'GET', '/ProfitCenters?$select=CenterCode,CenterName,InWhichDimension',
  );
  return result.value.map((item) => ({ code: item.CenterCode, name: item.CenterName, dimension: item.InWhichDimension }));
}

export async function testConnection(): Promise<{ ok: true }> {
  session = null;
  await login();
  return { ok: true };
}

/** For tests: forget the cached session and TLS agent. */
export function resetSapClient(): void {
  session = null;
  dispatcher = null;
}
