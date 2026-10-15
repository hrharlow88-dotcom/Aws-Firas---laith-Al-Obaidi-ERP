import { execute, select, selectOne } from '../db/query';
import { getSettings } from './settings';
import { verifyAuditChain } from './security';
import { blockIp } from './firewall';
import { encryptExistingFiles, plainFileCount } from './storage';
import { encryptionConfigured } from '../utils/crypto';

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'ok';

export interface Finding {
  id: string;
  severity: FindingSeverity;
  title: string;
  detail: string;
  items?: string[];
  fix?: { label: string };
}

export const isDemoInstance = () => process.env.DEMO_MODE === 'true';

/**
 * The radar's vulnerability scan: settings, accounts, files, attack traffic
 * and the audit trail. Each finding says what is wrong, and when the system
 * can correct it by itself it offers a one-click fix.
 */
export async function scanSystem(): Promise<Finding[]> {
  const settings = await getSettings();
  const s = settings.security;
  const findings: Finding[] = [];
  const add = (finding: Finding) => findings.push(finding);

  const chain = await verifyAuditChain();
  add(chain.broken
    ? { id: 'audit_chain', severity: 'critical', title: 'سجل التدقيق تعرّض لتلاعب', detail: `${chain.broken} عملية لا تطابق السلسلة، أولها رقم ${chain.firstBrokenSeq}. راجع من يملك صلاحية قاعدة البيانات.` }
    : { id: 'audit_chain', severity: 'ok', title: 'سجل التدقيق سليم', detail: `${chain.entries} عملية مسلسلة ومختومة.` });

  add((process.env.JWT_SECRET || '').length >= 48
    ? { id: 'jwt', severity: 'ok', title: 'مفتاح توقيع الجلسات قوي', detail: 'طوله كافٍ.' }
    : { id: 'jwt', severity: 'medium', title: 'مفتاح توقيع الجلسات قصير', detail: 'استبدله بمفتاح لا يقل عن 48 محرفاً في ملف .env على الخادم.' });

  if (!encryptionConfigured()) {
    add({ id: 'encryption_key', severity: 'critical', title: 'مفتاح التشفير غير مضبوط', detail: 'الهويات والحسابات المصرفية والملفات لا تُشفّر. اضبط DATA_ENCRYPTION_KEY على الخادم.' });
  } else {
    const plain = await plainFileCount();
    add(plain
      ? { id: 'plain_files', severity: 'medium', title: `${plain} ملف مخزون بلا تشفير`, detail: 'ملفات رُفعت قبل تفعيل التشفير عند التخزين.', fix: { label: 'تشفير الملفات الآن' } }
      : { id: 'plain_files', severity: 'ok', title: 'كل الملفات المخزونة مشفّرة', detail: 'AES-256-GCM بمفتاح الخادم.' });
  }

  add(s.wafEnabled
    ? { id: 'waf', severity: 'ok', title: 'جدار الحماية يصد أنماط الهجوم', detail: 'حقن SQL، تجاوز المسارات، حقن السكربت، JNDI.' }
    : { id: 'waf', severity: 'high', title: 'جدار الحماية متوقف', detail: 'الطلبات التي تحمل أنماط هجوم لا تُصد.', fix: { label: 'تشغيل جدار الحماية' } });
  add(s.autoBlockMinutes > 0
    ? { id: 'autoblock', severity: 'ok', title: 'الحظر التلقائي مفعّل', detail: `من يخمّن كلمات المرور يُحظر ${s.autoBlockMinutes} دقيقة.` }
    : { id: 'autoblock', severity: 'medium', title: 'الحظر التلقائي متوقف', detail: 'عناوين تخمين كلمات المرور لا تُحظر تلقائياً.', fix: { label: 'تفعيل الحظر لساعة' } });
  if (s.idleMinutes > 60) add({ id: 'idle', severity: 'medium', title: 'مدة الجلسة الخاملة طويلة', detail: `${s.idleMinutes} دقيقة. المستحسن 15–30.`, fix: { label: 'ضبطها على 15 دقيقة' } });

  const owners = await select<{ name: string }>("SELECT name FROM users WHERE role = 'super_admin' AND is_active");
  if (owners.length > 2) add({ id: 'owners', severity: 'medium', title: `${owners.length} حسابات بصلاحية مالك النظام`, detail: 'كلما قلّ عدد المالكين قلّ الخطر.', items: owners.map((row) => row.name) });

  const stale = await select<{ id: string; name: string }>(
    `SELECT id, name FROM users WHERE is_active AND NOT is_demo AND created_at < now() - interval '14 days'
       AND (last_login_at IS NULL OR last_login_at < now() - interval '90 days') AND role <> 'super_admin'`,
  );
  if (stale.length) add({ id: 'stale_accounts', severity: 'medium', title: `${stale.length} حساب لم يُستخدم منذ 90 يوماً`, detail: 'الحسابات المهجورة هدف سهل.', items: stale.slice(0, 30).map((row) => row.name), fix: { label: 'إيقافها' } });

  const leavers = await select<{ id: string; name: string }>(
    `SELECT u.id, u.name FROM users u JOIN employees e ON e.id = u.employee_id
     WHERE u.is_active AND e.termination_date IS NOT NULL AND e.termination_date < CURRENT_DATE`,
  );
  add(leavers.length
    ? { id: 'leaver_accounts', severity: 'high', title: `${leavers.length} حساب لموظف منفك ما زال فعّالاً`, detail: 'يجب إيقاف حسابات من ترك العمل.', items: leavers.map((row) => row.name), fix: { label: 'إيقافها وإنهاء جلساتها' } }
    : { id: 'leaver_accounts', severity: 'ok', title: 'لا توجد حسابات لموظفين منفكّين', detail: 'كل حسابات المنفكّين موقوفة.' });

  const demos = await select<{ id: string; name: string; expired: boolean }>(
    'SELECT id, name, (demo_expires_at IS NOT NULL AND demo_expires_at < now()) AS expired FROM users WHERE is_demo AND is_active',
  );
  if (demos.length && !isDemoInstance()) {
    add({ id: 'demo_accounts', severity: 'high', title: 'حسابات تجريبية فعّالة في النظام الحقيقي', detail: 'الحساب التجريبي يرى بيانات حقيقية هنا. استخدم نسخة العرض التجريبية.', items: demos.map((row) => row.name), fix: { label: 'إيقافها' } });
  } else if (demos.some((row) => row.expired)) {
    add({ id: 'demo_accounts', severity: 'medium', title: 'حسابات تجريبية منتهية ما زالت فعّالة', detail: '', items: demos.filter((row) => row.expired).map((row) => row.name), fix: { label: 'إيقافها' } });
  }

  const attacks = await select<{ ip: string; hits: string; kinds: string }>(
    `SELECT ip, count(*) AS hits, string_agg(DISTINCT COALESCE(details->>'kind', kind), '، ') AS kinds FROM security_events
     WHERE kind IN ('waf_blocked','rate_limited','login_failed') AND at > now() - interval '24 hours' AND ip IS NOT NULL
       AND ip NOT IN (SELECT ip FROM ip_blocks WHERE lifted_at IS NULL)
     GROUP BY ip HAVING count(*) >= 5 ORDER BY count(*) DESC LIMIT 20`,
  );
  add(attacks.length
    ? { id: 'attackers', severity: 'high', title: `${attacks.length} عنوان يهاجم النظام خلال 24 ساعة`, detail: 'محاولات دخول خاطئة أو طلبات خطرة أو إغراق.', items: attacks.map((row) => `${row.ip} — ${row.hits} (${row.kinds})`), fix: { label: 'حظرها 24 ساعة' } }
    : { id: 'attackers', severity: 'ok', title: 'لا توجد عناوين مهاجمة غير محظورة', detail: 'آخر 24 ساعة.' });

  const open = await selectOne<{ count: string }>("SELECT count(*) AS count FROM security_alerts WHERE resolved_at IS NULL AND severity IN ('critical','high')");
  if (Number(open?.count)) add({ id: 'open_alerts', severity: 'high', title: `${open!.count} تنبيه أمني مهم لم يُعالج`, detail: 'راجعها في تبويب التنبيهات.' });

  const channels = await select<{ channel: string }>('SELECT channel FROM message_channels WHERE enabled AND secret_enc IS NULL');
  if (channels.length) add({ id: 'channels', severity: 'low', title: 'قناة إرسال مفعّلة بلا مفتاح', detail: channels.map((row) => row.channel).join('، ') });

  const oldKeys = await select<{ name: string }>(
    "SELECT name FROM integration_api_keys WHERE revoked_at IS NULL AND created_at < now() - interval '180 days'",
  ).catch(() => []);
  if (oldKeys.length) add({ id: 'api_keys', severity: 'low', title: `${oldKeys.length} مفتاح ربط عمره أكثر من 6 أشهر`, detail: 'جدّد مفاتيح الأنظمة الخارجية دورياً.', items: oldKeys.map((row) => row.name) });

  const order: FindingSeverity[] = ['critical', 'high', 'medium', 'low', 'ok'];
  return findings.sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));
}

/** Applies the one-click fix of a finding. Returns a short Arabic summary. */
export async function fixFinding(id: string, userId: string): Promise<string> {
  const settingsRow = async (patch: (value: Record<string, any>) => void) => {
    const row = await selectOne<{ value: Record<string, any> }>("SELECT value FROM system_settings WHERE id = '00000000-0000-4000-8000-000000000001'");
    const value = row?.value ?? {};
    value.security = { ...(value.security ?? {}) };
    patch(value);
    await execute("UPDATE system_settings SET value = :value, updated_by = :userId, updated_at = now() WHERE id = '00000000-0000-4000-8000-000000000001'",
      { value: JSON.stringify(value), userId });
    const { invalidateSettingsCache } = await import('./settings');
    invalidateSettingsCache();
  };
  switch (id) {
    case 'plain_files': {
      const [done] = await encryptExistingFiles();
      return `شُفّر ${done} ملف.`;
    }
    case 'waf': await settingsRow((value) => { value.security.wafEnabled = true; }); return 'شُغّل جدار الحماية.';
    case 'autoblock': await settingsRow((value) => { value.security.autoBlockMinutes = 60; }); return 'فُعّل الحظر التلقائي لساعة.';
    case 'idle': await settingsRow((value) => { value.security.idleMinutes = 15; }); return 'ضُبطت الجلسة على 15 دقيقة.';
    case 'stale_accounts': {
      const rows = await execute(`UPDATE users SET is_active = false, token_version = token_version + 1 WHERE is_active AND NOT is_demo
        AND created_at < now() - interval '14 days' AND (last_login_at IS NULL OR last_login_at < now() - interval '90 days') AND role <> 'super_admin' RETURNING id`);
      return `أُوقف ${rows.length} حساب.`;
    }
    case 'leaver_accounts': {
      const rows = await execute(`UPDATE users u SET is_active = false, token_version = token_version + 1 FROM employees e
        WHERE e.id = u.employee_id AND u.is_active AND e.termination_date IS NOT NULL AND e.termination_date < CURRENT_DATE RETURNING u.id`);
      return `أُوقف ${rows.length} حساب.`;
    }
    case 'demo_accounts': {
      const rows = await execute(`UPDATE users SET is_active = false, token_version = token_version + 1 WHERE is_demo AND is_active
        ${isDemoInstance() ? 'AND demo_expires_at < now()' : ''} RETURNING id`);
      return `أُوقف ${rows.length} حساب تجريبي.`;
    }
    case 'attackers': {
      const rows = await select<{ ip: string }>(
        `SELECT ip FROM security_events WHERE kind IN ('waf_blocked','rate_limited','login_failed') AND at > now() - interval '24 hours' AND ip IS NOT NULL
         GROUP BY ip HAVING count(*) >= 5`,
      );
      let blocked = 0;
      for (const row of rows) if (await blockIp(row.ip, 'حظر من رادار الحماية: هجمات متكررة', 1440, userId, false)) blocked += 1;
      return `حُظر ${blocked} عنوان لمدة 24 ساعة.`;
    }
    default: throw new Error('UNKNOWN_FIX');
  }
}
