/**
 * Employee photos from one ZIP, end to end in Chromium on the e2e copy (made-up data):
 * the owner uploads a ZIP built here, reads the preview, confirms, downloads the report,
 * and finds the photos in the directory, the org chart and the employee file; a second ZIP
 * replaces a photo only once replacing is ticked. Also checks that the version shows as
 * «إصدار X» alone (no icon) and the developer credit as «بناء وتطوير».
 *
 *   BASE=http://127.0.0.1:5077 TOKENS=tokens.json DB_NAME=laith_erp_e2e node photo-zip.mjs
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';

const require = createRequire(new URL('../backend/package.json', import.meta.url));
const sharp = require('sharp');
const JSZip = require('jszip');
const { Client } = require('pg');

const BASE = process.env.BASE || 'http://127.0.0.1:5077';
const tokens = JSON.parse(fs.readFileSync(process.env.TOKENS || 'tokens.json', 'utf8'));
const database = process.env.DB_NAME || '';
if (!/e2e/.test(database)) throw new Error('Refusing: this check only runs on a database whose name contains "e2e".');

const failures = [];
const OUT = process.env.OUT || 'results';
fs.mkdirSync(`${OUT}/shots`, { recursive: true });
/** SHOTS=all keeps a picture of each step, to look at the flow. */
const shot = async (name) => { if (process.env.SHOTS === 'all') await page.screenshot({ path: `${OUT}/shots/zip_${name}.png`, fullPage: true }); };
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures.push(what); };

const db = new Client({
  host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 5432), database,
  user: process.env.DB_USER || 'erp', password: process.env.DB_PASSWORD || 'erp_dev_pw',
});
await db.connect();
const people = (await db.query(
  `SELECT id, employee_no AS "employeeNo", full_name AS "fullName" FROM employees
   WHERE employment_status <> 'inactive' AND photo_document_id IS NULL ORDER BY employee_no LIMIT 3`,
)).rows;
if (people.length < 3) throw new Error('The e2e copy needs three employees without a photo.');

const picture = (color, format = 'jpeg') => sharp({ create: { width: 400, height: 500, channels: 3, background: color } })[format]().toBuffer();
async function zipOf(files) {
  const zip = new JSZip();
  for (const [name, data] of files) zip.file(name, data);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
const first = await zipOf([
  [`${people[0].employeeNo}.jpg`, await picture('#c0392b')],
  [`صور/${people[1].employeeNo}.png`, await picture('#2471a3', 'png')],
  [`${people[2].employeeNo}.jpg`, Buffer.from('this is not a picture')],
  ['0000000000.jpg', await picture('#1e8449')],
  ['notes.txt', Buffer.from('ملاحظات')],
]);

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
const WIDTH = Number(process.env.WIDTH || 1440);
const phone = WIDTH < 768;
const context = await browser.newContext({ viewport: { width: WIDTH, height: phone ? 844 : 900 }, locale: 'ar-IQ', isMobile: phone, hasTouch: phone, acceptDownloads: true });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text().slice(0, 200)); });
page.on('response', (response) => { if (response.url().includes('/api/') && response.status() >= 400) errors.push(`${response.status()} ${response.url().replace(BASE, '')}`); });

process.on('uncaughtException', async (error) => {
  console.log(`FAIL stopped: ${String(error).split('\n')[0]}`);
  console.log(`   errors so far: ${errors.slice(0, 8).join(' | ') || 'none'}`);
  try { console.log(`   screen: ${(await page.textContent('main'))?.replace(/\s+/g, ' ').slice(0, 400)}`); } catch { /* closed */ }
  process.exit(1);
});

// Signed out: the login page shows the version alone and the credit without «إعداد».
await page.goto(`${BASE}/`);
await page.waitForSelector('.login-version');
const health = await (await fetch(`${BASE}/api/health`)).json();
const expected = `إصدار ${health.version.replace(/\.0$/, '')}`;
check((await page.textContent('.login-version'))?.trim() === expected, `login page shows «${expected}» only`);
check(await page.locator('.login-version svg').count() === 0, 'no icon beside the version on the login page');
const credit = (await page.locator('.developer-credit').first().textContent()) ?? '';
check(credit.includes('بناء وتطوير') && !credit.includes('إعداد'), 'developer credit reads «بناء وتطوير»');

await page.evaluate((token) => {
  sessionStorage.setItem('erp_token', token); localStorage.setItem('erp.lang', 'ar');
  localStorage.setItem('erp.installLater', String(Date.now() + 864e5));
}, tokens.owner);
await page.goto(`${BASE}/#/employees-import`);
await page.reload();
for (let i = 0; i < 10; i += 1) {
  const read = page.locator('.announce-actions .button-primary');
  if (!(await read.count())) break;
  await read.first().click();
  await page.waitForTimeout(400);
}
check((await page.textContent('.page-footer .version-badge'))?.trim() === expected, `footer shows «${expected}» only`);
check(await page.locator('.page-footer .version-badge svg').count() === 0, 'no icon beside the version in the footer');

await page.getByRole('tab', { name: /الصور/ }).click();
await page.waitForSelector('.zip-guide');
await shot('1-guide');
check((await page.textContent('.zip-guide')).includes('10172.jpg'), 'naming guide beside the upload button');
await page.setInputFiles('.zip-panel input[type=file]', { name: 'photos.zip', mimeType: 'application/zip', buffer: first });
await page.waitForSelector('.zip-table', { timeout: 60000 });
const statText = await page.textContent('.zip-panel .stat-row');
await shot('2-preview');
check(/جاهزة للإضافة\s*2/.test(statText.replace(/\s+/g, ' ')), 'preview: 2 photos ready');
check(await page.locator('.zip-table img.zip-thumb').count() >= 3, 'preview shows the photos themselves');
const rows = await page.locator('.zip-table tbody tr').allTextContents();
check(rows.some((row) => row.includes(people[0].fullName) && row.includes('جاهزة')), 'preview: the first photo matched its employee by number');
check(rows.some((row) => row.includes('0000000000') && row.includes('غير مطابقة')), 'preview: an unknown number is marked unmatched');
check(rows.some((row) => row.includes(people[2].employeeNo) && row.includes('تالفة')), 'preview: a broken file is marked damaged');
check(rows.some((row) => row.includes('notes.txt') && row.includes('ليست صورة')), 'preview: a text file is marked not a picture');
const linkedBefore = (await db.query('SELECT count(*)::int AS n FROM employees WHERE id = ANY($1::uuid[]) AND photo_document_id IS NOT NULL', [people.map((person) => person.id)])).rows[0].n;
check(linkedBefore === 0, 'nothing saved before confirming');

await page.getByRole('button', { name: /تأكيد ورفع 2 صورة/ }).click();
await page.waitForSelector('text=رفع ملف آخر', { timeout: 60000 });
const resultText = (await page.textContent('.zip-panel .stat-row')).replace(/\s+/g, ' ');
await shot('3-result');
check(/أُضيفت\s*2/.test(resultText) && /فشلت\s*2/.test(resultText) && /تُجوزت\s*1/.test(resultText), 'result: 2 added, 1 skipped, 2 failed');
const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'تنزيل التقرير' }).click()]);
const report = fs.readFileSync(await download.path(), 'utf8');
check(report.includes(people[0].employeeNo) && report.includes('أُضيفت') && report.includes('السبب'), 'report downloads with every file, result and reason');
check(report.includes('"=""0000000000"""'), 'report keeps a number with leading zeros as written (Excel shows 0000000000, not 0)');
const saved = (await db.query('SELECT id FROM employees WHERE id = ANY($1::uuid[]) AND photo_document_id IS NOT NULL', [[people[0].id, people[1].id]])).rows.length;
check(saved === 2, 'both photos are linked to their employees in the database');

await page.goto(`${BASE}/#/employees`);
await page.waitForSelector('.directory-table, .card-grid, .kanban-board');
await page.locator('.search-field input').fill(people[0].employeeNo);
await page.waitForTimeout(1500);
check(await page.locator('.directory-table img.person-mark').count() >= 1, 'directory shows the employee photo');
await shot('4-directory');
await page.goto(`${BASE}/#/org`);
await page.getByRole('tab', { name: 'المخطط التنظيمي' }).click();
await page.waitForSelector('.org-chart, .chart-loose, .empty');
const expand = page.getByRole('button', { name: 'توسيع الكل' });
if (await expand.count()) await expand.click();
await page.waitForTimeout(1500);
const chartPhotos = await page.locator('img.chart-photo').count();
await shot('5-org-chart');
console.log(`     (${chartPhotos} photos on the chart)`);
const onChart = (await db.query("SELECT count(*)::int AS n FROM employees WHERE id = ANY($1::uuid[]) AND manager_id IS NOT NULL", [[people[0].id, people[1].id]])).rows[0].n;
check(onChart === 0 || chartPhotos >= 1, 'org chart shows employee photos');

// A second ZIP with a new photo for someone who now has one: kept unless replacing is ticked.
const oldDocument = (await db.query('SELECT photo_document_id AS d FROM employees WHERE id = $1', [people[0].id])).rows[0].d;
await page.goto(`${BASE}/#/employees-import`);
await page.getByRole('tab', { name: /الصور/ }).click();
await page.setInputFiles('.zip-panel input[type=file]', { name: 'again.zip', mimeType: 'application/zip', buffer: await zipOf([[`${people[0].employeeNo}.jpg`, await picture('#f1c40f')]]) });
await page.waitForSelector('.zip-table', { timeout: 60000 });
check(await page.getByRole('button', { name: /تأكيد ورفع 0 صورة/ }).isDisabled(), 'nothing to save while replacing is not ticked');
await shot('6-has-photo');
await page.locator('.zip-replace input').check();
await shot('7-replace-ticked');
await page.getByRole('button', { name: /تأكيد ورفع 1 صورة/ }).click();
await page.waitForSelector('text=رفع ملف آخر', { timeout: 60000 });
check(/استُبدلت\s*1/.test((await page.textContent('.zip-panel .stat-row')).replace(/\s+/g, ' ')), 'result: 1 replaced');
const newDocument = (await db.query('SELECT photo_document_id AS d FROM employees WHERE id = $1', [people[0].id])).rows[0].d;
check(newDocument && newDocument !== oldDocument, 'the replaced photo is a new document');

await page.goto(`${BASE}/#/employees/${people[0].id}`);
await page.waitForSelector('.profile-photo-wrap img.employee-photo', { timeout: 15000 }).catch(() => undefined);
check(await page.locator('.profile-photo-wrap img.employee-photo').count() === 1, 'the employee file shows the new photo');
await shot('8-profile');

const unexpected = errors.filter((text) => !/favicon/.test(text));
check(!unexpected.length, `no page errors or failed requests${unexpected.length ? `: ${unexpected.slice(0, 5).join(' | ')}` : ''}`);
await browser.close();
await db.end();
console.log(`\n${failures.length ? `${failures.length} photo ZIP checks failed` : 'all photo ZIP checks passed'}.`);
process.exitCode = failures.length ? 1 : 0;
