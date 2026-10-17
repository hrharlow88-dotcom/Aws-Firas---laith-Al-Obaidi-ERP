/**
 * Opens every screen of the system in Chromium at phone and computer widths and
 * fails when one scrolls sideways, throws an error, gets a failed API answer,
 * shows text under 12px on a phone, or opens empty.
 *
 *   BASE=http://127.0.0.1:5077 TOKENS=tokens.json node screens.mjs
 *
 * tokens.json (written by tokens.mjs): { owner, employee, employeeId, runId }.
 * WIDTHS (default 1440,390,320), ONLY (comma-separated routes), CHROMIUM (browser path), OUT (default results)
 * SHOTS=all (a screenshot of every screen, to compare two builds) and MODE=dark are optional.
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const BASE = process.env.BASE || 'http://127.0.0.1:5077';
const tokens = JSON.parse(fs.readFileSync(process.env.TOKENS || 'tokens.json', 'utf8'));
const WIDTHS = (process.env.WIDTHS || '1440,390,320').split(',').map(Number);
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
const OUT = process.env.OUT || 'results';

const OWNER_PAGES = [
  'home', 'overview', 'employees', `employees/${tokens.employeeId}`, 'employees-import', 'org', 'branches', 'companies',
  'contract-templates', 'former-employees', 'attendance', 'leaves', 'leave-accrual', 'comp-leave', 'holidays', 'calendar',
  'payroll', ...(tokens.runId ? [`payroll/${tokens.runId}`] : []), 'payroll-days', 'loans', 'payroll-archive', 'payroll-register',
  'requests', 'portal-accounts', 'discipline', 'tickets', 'recruitment', 'kpi', 'documents-check', 'approvals', 'expenses',
  'approval-requests', 'approval-categories', 'announcements', 'messages', 'chat', 'notices', 'archive', 'finance', 'audit',
  'activity', 'integrations', 'access', 'settings', 'security', 'company-import', 'owner', 'guard', 'recycle-bin', 'ai', 'feedback',
];
const EMPLOYEE_PAGES = ['home', 'my', 'my-payslip', 'my-tickets', 'calendar', 'approvals', 'chat', 'expenses', 'approval-requests', 'security', 'notices'];

/* Runs in the page: what sticks out sideways, text under 12px (outside drawings), and whether the screen is empty. */
function measure(deviceWidth) {
  const doc = document.documentElement;
  const overflow = Math.max(doc.scrollWidth, document.body.scrollWidth, window.innerWidth) - deviceWidth;
  const describe = (el) => el.tagName.toLowerCase() + (el.classList.length ? `.${[...el.classList].slice(0, 3).join('.')}` : '');
  const scrollsX = (el) => /(auto|scroll)/.test(getComputedStyle(el).overflowX) && el.scrollWidth > el.clientWidth;
  const offenders = [];
  const all = document.querySelectorAll('body *');
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || (r.right <= deviceWidth + 1 && r.left >= -1)) continue;
    let p = el.parentElement; let inside = false;
    while (p && p !== document.body) { if (scrollsX(p) || (p.tagName === 'DIALOG' && getComputedStyle(p).position === 'fixed')) { inside = true; break; } p = p.parentElement; }
    if (!inside) offenders.push(`${describe(el)} [${Math.round(r.left)}..${Math.round(r.right)}]`);
    if (offenders.length > 8) break;
  }
  const tiny = [];
  for (const el of all) {
    if (el.closest('svg') || ![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1)) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const size = parseFloat(getComputedStyle(el).fontSize);
    if (size < 12) tiny.push(`${describe(el)} ${size.toFixed(1)}px`);
  }
  const main = document.querySelector('main');
  return { overflow, offenders, tiny: tiny.slice(0, 6), tinyCount: tiny.length, empty: !main || main.innerText.trim().length < 20 };
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
const results = [];
let failures = 0;
fs.mkdirSync(path.join(OUT, 'shots'), { recursive: true });

for (const [who, token, pages] of [['owner', tokens.owner, OWNER_PAGES], ['employee', tokens.employee, EMPLOYEE_PAGES]]) {
  for (const width of WIDTHS) {
    const phone = width < 768;
    const context = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, locale: 'ar-IQ', isMobile: phone, hasTouch: phone });
    const page = await context.newPage();
    await page.goto(`${BASE}/`);
    await page.evaluate(([t, mode]) => {
      sessionStorage.setItem('erp_token', t); localStorage.setItem('erp.lang', 'ar'); localStorage.setItem('erp.mode', mode);
      localStorage.setItem('erp.installLater', String(Date.now() + 864e5));
    }, [token, process.env.MODE || 'light']);
    await page.reload();
    await page.waitForTimeout(1200);
    // Announcements open full screen until read: read them, as a person would, so the screens behind are measured.
    for (let i = 0; i < 10; i += 1) {
      const read = page.locator('.announce-actions .button-primary');
      if (!(await read.count())) break;
      await read.first().click();
      await page.waitForTimeout(500);
    }
    for (const route of pages) {
      if (ONLY && !ONLY.includes(route)) continue;
      const errors = []; const failed = [];
      const onError = (error) => errors.push(`pageerror: ${String(error).slice(0, 200)}`);
      const onConsole = (message) => { if (message.type() === 'error') errors.push(`console: ${message.text().slice(0, 200)}`); };
      const onResponse = (response) => {
        const url = response.url();
        if (url.includes('/api/') && response.status() >= 400 && !url.includes('/logo')) failed.push(`${response.status()} ${response.request().method()} ${url.replace(BASE, '')}`);
      };
      page.on('pageerror', onError); page.on('console', onConsole); page.on('response', onResponse);
      await page.goto(`${BASE}/#/${route}`);
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => undefined);
      await page.waitForTimeout(400);
      const m = await page.evaluate(measure, width);
      page.off('pageerror', onError); page.off('console', onConsole); page.off('response', onResponse);
      const problems = [
        ...(m.overflow > 0 ? [`scrolls sideways by ${m.overflow}px: ${m.offenders.join(', ')}`] : []),
        ...errors, ...failed.map((item) => `request failed: ${item}`),
        ...(phone && m.tinyCount ? [`${m.tinyCount} texts under 12px: ${m.tiny.join(', ')}`] : []),
        ...(m.empty ? ['screen is empty'] : []),
      ];
      if (problems.length) failures += 1;
      // SHOTS=all keeps a picture of every screen (to compare two builds); otherwise only of the failures.
      if (problems.length || process.env.SHOTS === 'all') {
        await page.screenshot({ path: path.join(OUT, 'shots', `${who}_${route.replace(/\//g, '_')}_${width}.png`), fullPage: true, animations: 'disabled', caret: 'hide' });
      }
      results.push({ who, route, width, problems });
      console.log(`${problems.length ? 'FAIL' : 'ok  '} ${who.padEnd(8)} ${route.padEnd(28)} ${String(width).padStart(4)}${problems.length ? `  ${problems.join(' | ')}` : ''}`);
    }
    await context.close();
  }
}
await browser.close();
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 1));
console.log(`\n${results.length - failures}/${results.length} screen checks passed${failures ? `; screenshots of the failures in ${path.join(OUT, 'shots')}` : ''}.`);
process.exitCode = failures ? 1 : 0;
