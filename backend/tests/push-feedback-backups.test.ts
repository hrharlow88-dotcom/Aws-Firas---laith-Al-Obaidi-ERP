import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import webpush from 'web-push';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { execute, select, selectOne, transaction } from '../src/db/query';
import { runHrReminders } from '../src/services/hrReminders';
import { notifyUsers } from '../src/services/notify';
import { pushEndpointAllowed } from '../src/services/push';
import { decryptField } from '../src/utils/crypto';
import { api, makeBranch, makeEmployee, makeUser } from './helpers';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

let owner: Awaited<ReturnType<typeof makeUser>>;
let hr: Awaited<ReturnType<typeof makeUser>>;
let staff: Awaited<ReturnType<typeof makeUser>>;
let other: Awaited<ReturnType<typeof makeUser>>;

/** What a browser hands over when it subscribes: its push address and two keys. */
function browserSubscription(host = 'fcm.googleapis.com') {
  const key = createECDH('prime256v1');
  key.generateKeys();
  return {
    endpoint: `https://${host}/fcm/send/${randomUUID()}`,
    expirationTime: null,
    keys: { p256dh: key.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') },
  };
}

async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

beforeAll(async () => {
  owner = await makeUser('super_admin');
  hr = await makeUser('hr_manager');
  const branch = await makeBranch('فرع الملاحظات');
  staff = await makeUser('employee', null, (await makeEmployee(branch.id, { fullName: 'موظف الملاحظات' })).id);
  other = await makeUser('employee', null, (await makeEmployee(branch.id, { fullName: 'موظف آخر' })).id);
});

afterAll(async () => {
  // Leave push off so notices from other test files never try to reach a phone.
  await api().put('/api/push/channel').set(owner.auth).send({ enabled: false }).expect(200);
  await execute('DELETE FROM push_subscriptions');
  delete process.env.BACKUP_DIR;
});

afterEach(() => { vi.restoreAllMocks(); });

describe('phone notifications (Web Push)', () => {
  it('stays off until the owner switches it on, and only the owner can', async () => {
    expect((await api().get('/api/push/config').set(staff.auth).expect(200)).body.data.publicKey).toBeNull();
    const early = await api().post('/api/push/subscriptions').set(staff.auth).send(browserSubscription());
    expect(early.status).toBe(409);
    await api().put('/api/push/channel').set(hr.auth).send({ enabled: true }).expect(403);
    await api().get('/api/push/status').set(hr.auth).expect(403);
    await api().put('/api/push/channel').set(owner.auth).send({ enabled: 'yes' }).expect(400);

    const on = await api().put('/api/push/channel').set(owner.auth).send({ enabled: true }).expect(200);
    expect(on.body.data).toMatchObject({ enabled: true });
    const key = (await api().get('/api/push/config').set(staff.auth).expect(200)).body.data.publicKey as string;
    expect(key).toMatch(/^[A-Za-z0-9_-]{80,}$/);
    // The private key is stored encrypted, never in the clear.
    const row = await selectOne<{ secret: string; config: { publicKey: string } }>("SELECT secret_enc AS secret, config FROM message_channels WHERE channel = 'push'");
    expect(row!.config.publicKey).toBe(key);
    expect(row!.secret.startsWith('enc:v1:')).toBe(true);
    expect(decryptField(row!.secret)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const audit = await selectOne("SELECT id FROM audit_logs WHERE action = 'push.enabled' AND user_id = :id", { id: owner.user.id });
    expect(audit).toBeTruthy();

    // Off and on again keeps the same keys, so devices already registered keep working.
    await api().put('/api/push/channel').set(owner.auth).send({ enabled: false }).expect(200);
    expect((await api().get('/api/push/config').set(staff.auth).expect(200)).body.data.publicKey).toBeNull();
    await api().put('/api/push/channel').set(owner.auth).send({ enabled: true }).expect(200);
    expect((await api().get('/api/push/config').set(staff.auth).expect(200)).body.data.publicKey).toBe(key);
  });

  it('accepts only real browser push services and well-formed keys', async () => {
    expect(pushEndpointAllowed('https://fcm.googleapis.com/fcm/send/abc')).toBe(true);
    expect(pushEndpointAllowed('https://web.push.apple.com/QGx')).toBe(true);
    expect(pushEndpointAllowed('https://updates.push.services.mozilla.com/wpush/v2/x')).toBe(true);
    expect(pushEndpointAllowed('https://wns2-par02p.notify.windows.com/w/?token=x')).toBe(true);
    for (const bad of ['http://fcm.googleapis.com/fcm/send/x', 'https://fcm.googleapis.com:8443/x', 'https://evil.example.com/push',
      'https://fcm.googleapis.com.evil.example/x', 'https://127.0.0.1/x', 'not a url']) {
      expect(pushEndpointAllowed(bad)).toBe(false);
    }
    const good = browserSubscription();
    await api().post('/api/push/subscriptions').set(staff.auth).send({ ...good, endpoint: 'https://evil.example.com/push/1' }).expect(400);
    await api().post('/api/push/subscriptions').set(staff.auth).send({ ...good, keys: { p256dh: 'short', auth: good.keys.auth } }).expect(400);
    await api().post('/api/push/subscriptions').set(staff.auth).send({ ...good, keys: { p256dh: good.keys.p256dh, auth: 'a b' } }).expect(400);
    await api().post('/api/push/subscriptions').set(staff.auth).send({ ...good, extra: 1 }).expect(400);
    await api().post('/api/push/subscriptions').send(good).expect(401);
  });

  it('registers a device per person, and a device that changes hands follows the newer account', async () => {
    const device = browserSubscription();
    const first = await api().post('/api/push/subscriptions').set(staff.auth).send({ ...device, device: 'Android · Chrome' }).expect(201);
    expect(first.body.data.devices).toBe(1);
    await api().post('/api/push/subscriptions').set(staff.auth).send(device).expect(201);
    expect((await api().get('/api/push/config').set(staff.auth).expect(200)).body.data.devices).toBe(1);

    await api().post('/api/push/subscriptions').set(other.auth).send(device).expect(201);
    expect((await api().get('/api/push/config').set(staff.auth).expect(200)).body.data.devices).toBe(0);
    expect((await api().get('/api/push/config').set(other.auth).expect(200)).body.data.devices).toBe(1);

    // Someone else cannot remove my device by its address.
    await api().delete('/api/push/subscriptions').set(staff.auth).send({ endpoint: device.endpoint }).expect(200);
    expect((await api().get('/api/push/config').set(other.auth).expect(200)).body.data.devices).toBe(1);
    const gone = await api().delete('/api/push/subscriptions').set(other.auth).send({ endpoint: device.endpoint }).expect(200);
    expect(gone.body.data.devices).toBe(0);

    const status = await api().get('/api/push/status').set(owner.auth).expect(200);
    expect(status.body.data).toMatchObject({ enabled: true });
  });

  it('sends to my devices, and drops a device the push service no longer knows', async () => {
    const device = browserSubscription();
    await api().post('/api/push/subscriptions').set(hr.auth).send(device).expect(201);
    const key = (await api().get('/api/push/config').set(hr.auth).expect(200)).body.data.publicKey;
    const send = vi.spyOn(webpush, 'sendNotification').mockResolvedValue({ statusCode: 201, body: '', headers: {} });

    const result = await api().post('/api/push/test').set(hr.auth).expect(200);
    expect(result.body.data).toEqual({ sent: 1, failed: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    const [target, payload, options] = send.mock.calls[0];
    expect(target.endpoint).toBe(device.endpoint);
    expect(JSON.parse(String(payload))).toMatchObject({ title: 'إشعار تجريبي من النظام', link: '/home', tag: 'test' });
    expect(options?.vapidDetails?.publicKey).toBe(key);
    expect(options?.TTL).toBe(24 * 3600);
    const kept = await selectOne<{ lastSuccessAt: string | null }>('SELECT last_success_at AS "lastSuccessAt" FROM push_subscriptions WHERE endpoint = :endpoint', { endpoint: device.endpoint });
    expect(kept!.lastSuccessAt).not.toBeNull();

    send.mockRejectedValue(Object.assign(new Error('gone'), { statusCode: 410 }));
    expect((await api().post('/api/push/test').set(hr.auth).expect(200)).body.data).toEqual({ sent: 0, failed: 1 });
    expect(await selectOne('SELECT id FROM push_subscriptions WHERE endpoint = :endpoint', { endpoint: device.endpoint })).toBeNull();
  });

  it('pushes an in-system notice after its change commits, and nothing for a change that rolled back', async () => {
    const device = browserSubscription();
    await api().post('/api/push/subscriptions').set(owner.auth).send(device).expect(201);
    const send = vi.spyOn(webpush, 'sendNotification').mockResolvedValue({ statusCode: 201, body: '', headers: {} });
    const titles = () => send.mock.calls.map((call) => JSON.parse(String(call[1])).title as string);

    await expect(transaction(async (tx) => {
      await notifyUsers([owner.user.id], { kind: 'leave', title: 'إشعار تراجع', body: null, link: '/leaves' }, tx);
      throw new Error('rollback');
    })).rejects.toThrow('rollback');
    await transaction(async (tx) => {
      await notifyUsers([owner.user.id], { kind: 'leave', title: 'طلب إجازة جديد', body: 'من موظف الملاحظات', link: '/leaves' }, tx);
    });
    await waitFor(() => titles().includes('طلب إجازة جديد'));
    expect(titles()).not.toContain('إشعار تراجع');
    const payload = JSON.parse(String(send.mock.calls.find((call) => JSON.parse(String(call[1])).title === 'طلب إجازة جديد')![1]));
    expect(payload).toMatchObject({ body: 'من موظف الملاحظات', link: '/leaves', tag: 'leave' });

    // Switched off: nothing leaves the server.
    send.mockClear();
    await api().put('/api/push/channel').set(owner.auth).send({ enabled: false }).expect(200);
    expect((await api().post('/api/push/test').set(owner.auth).expect(200)).body.data).toEqual({ sent: 0, failed: 0 });
    expect(send).not.toHaveBeenCalled();
    await api().put('/api/push/channel').set(owner.auth).send({ enabled: true }).expect(200);
    await api().delete('/api/push/subscriptions').set(owner.auth).send({ endpoint: device.endpoint }).expect(200);
  });
});

describe('feedback on the system', () => {
  let noteId: string;
  let refNo: string;

  it('takes a fault with its screen, version and screenshot, and tells the owner', async () => {
    const created = await api().post('/api/feedback').set(staff.auth)
      .field('kind', 'bug').field('message', 'زر الحفظ لا يعمل في شاشة الإجازات من التلفون')
      .field('page', '/leaves').field('appVersion', '2.0.0').field('viewport', '390x844')
      .attach('file', PNG, { filename: 'shot.png', contentType: 'image/png' })
      .expect(201);
    noteId = created.body.data.id;
    refNo = created.body.data.refNo;
    expect(refNo).toMatch(/^FB-\d{4,}$/);

    const notice = await selectOne<{ title: string; link: string }>(
      'SELECT title, link FROM notifications WHERE user_id = :id ORDER BY created_at DESC LIMIT 1', { id: owner.user.id });
    expect(notice).toMatchObject({ title: `ملاحظة جديدة على النظام ${refNo}`, link: '/feedback' });

    const second = await api().post('/api/feedback').set(staff.auth).field('kind', 'idea').field('message', 'أضيفوا تقرير الغياب الشهري').expect(201);
    expect(Number(second.body.data.refNo.slice(3))).toBe(Number(refNo.slice(3)) + 1);
  });

  it('refuses a note without a kind or text, or with a file that is not an image', async () => {
    await api().post('/api/feedback').set(staff.auth).field('message', 'بلا نوع').expect(400);
    await api().post('/api/feedback').set(staff.auth).field('kind', 'complaint').field('message', 'نوع غير معروف').expect(400);
    await api().post('/api/feedback').set(staff.auth).field('kind', 'bug').field('message', 'ab').expect(400);
    await api().post('/api/feedback').set(staff.auth).field('kind', 'bug').field('message', 'x'.repeat(2001)).expect(400);
    await api().post('/api/feedback').set(staff.auth).field('kind', 'bug').field('message', 'ملف غير صورة')
      .attach('file', Buffer.from('%PDF-1.4 not an image'), { filename: 'a.pdf', contentType: 'application/pdf' }).expect(400);
    await api().post('/api/feedback').set(staff.auth).field('kind', 'bug').field('message', 'حقل زائد').field('userId', owner.user.id).expect(400);
    await api().post('/api/feedback').field('kind', 'bug').field('message', 'بلا دخول').expect(401);
  });

  it('is read by the owner only; the screenshot by the owner and its author', async () => {
    await api().get('/api/feedback').set(hr.auth).expect(403);
    const list = await api().get('/api/feedback?status=new').set(owner.auth).expect(200);
    const row = list.body.data.rows.find((item: { id: string }) => item.id === noteId);
    expect(row).toMatchObject({ refNo, kind: 'bug', page: '/leaves', appVersion: '2.0.0', viewport: '390x844', hasImage: true, status: 'new', userName: staff.user.name });
    expect(list.body.data.counts.new).toBeGreaterThanOrEqual(2);

    const image = await api().get(`/api/feedback/${noteId}/image`).set(owner.auth).expect(200);
    expect(image.headers['content-type']).toBe('image/png');
    expect(Buffer.from(image.body).equals(PNG)).toBe(true);
    await api().get(`/api/feedback/${noteId}/image`).set(staff.auth).expect(200);
    await api().get(`/api/feedback/${noteId}/image`).set(other.auth).expect(404);
    await api().get('/api/feedback/not-a-uuid/image').set(owner.auth).expect(400);

    const mine = (await api().get('/api/feedback/mine').set(other.auth).expect(200)).body.data;
    expect(mine.some((item: { id: string }) => item.id === noteId)).toBe(false);
  });

  it('the owner answers and the author is told', async () => {
    await api().patch(`/api/feedback/${noteId}`).set(hr.auth).send({ status: 'done' }).expect(403);
    await api().patch(`/api/feedback/${noteId}`).set(owner.auth).send({ status: 'closed' }).expect(400);
    await api().patch(`/api/feedback/${randomUUID()}`).set(owner.auth).send({ status: 'done' }).expect(404);
    await api().patch(`/api/feedback/${noteId}`).set(owner.auth).send({ status: 'done', ownerNote: 'أُصلح في 2.0.1' }).expect(200);

    const mine = (await api().get('/api/feedback/mine').set(staff.auth).expect(200)).body.data;
    expect(mine.find((item: { id: string }) => item.id === noteId)).toMatchObject({ status: 'done', ownerNote: 'أُصلح في 2.0.1' });
    const told = await selectOne<{ title: string; body: string }>(
      'SELECT title, body FROM notifications WHERE user_id = :id ORDER BY created_at DESC LIMIT 1', { id: staff.user.id });
    expect(told).toEqual({ title: `ملاحظتك ${refNo}: تمت`, body: 'أُصلح في 2.0.1' });
    const done = (await api().get('/api/feedback?status=done').set(owner.auth).expect(200)).body.data.rows;
    expect(done.map((item: { id: string }) => item.id)).toContain(noteId);
  });
});

describe('backups kept off the server', () => {
  let dir: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-backups-'));
    const files: Array<[string, string, string]> = [
      ['db_2031-03-01_0200.dump', 'database one', '2031-03-01T02:00:00Z'],
      ['uploads_2031-03-01_0200.tar.gz', 'files one', '2031-03-01T02:01:00Z'],
      ['db_pre-update_2031-03-02_1200.dump', 'before update', '2031-03-02T12:00:00Z'],
      ['notes.txt', 'not a backup', '2031-03-03T00:00:00Z'],
      ['db_2031-03-01_0200.dump.bak', 'not listed', '2031-03-03T00:00:00Z'],
    ];
    for (const [name, content, at] of files) {
      fs.writeFileSync(path.join(dir, name), content);
      fs.utimesSync(path.join(dir, name), new Date(at), new Date(at));
    }
    fs.writeFileSync(path.join(path.dirname(dir), 'db_2031-03-01_0300.dump'), 'outside the folder');
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(path.join(path.dirname(dir), 'db_2031-03-01_0300.dump'), { force: true });
  });

  it('says so when the backups folder is not attached', async () => {
    delete process.env.BACKUP_DIR;
    expect((await api().get('/api/owner/backups').set(owner.auth).expect(200)).body.data).toMatchObject({ available: false, files: [] });
  });

  it('lists only the nightly and pre-update backups, newest first, to the owner only', async () => {
    process.env.BACKUP_DIR = dir;
    await api().get('/api/owner/backups').set(hr.auth).expect(403);
    const list = (await api().get('/api/owner/backups').set(owner.auth).expect(200)).body.data;
    expect(list.available).toBe(true);
    expect(list.files.map((file: { name: string }) => file.name)).toEqual([
      'db_pre-update_2031-03-02_1200.dump', 'uploads_2031-03-01_0200.tar.gz', 'db_2031-03-01_0200.dump',
    ]);
    expect(list.files[1]).toMatchObject({ kind: 'files', size: 'files one'.length });
  });

  it('downloads a listed backup, records who did, and refuses any other name', async () => {
    process.env.BACKUP_DIR = dir;
    await api().get('/api/owner/backups/db_2031-03-01_0200.dump').set(hr.auth).expect(403);
    const file = await api().get('/api/owner/backups/db_2031-03-01_0200.dump').set(owner.auth)
      .buffer(true).parse((res, done) => { const chunks: Buffer[] = []; res.on('data', (chunk: Buffer) => chunks.push(chunk)); res.on('end', () => done(null, Buffer.concat(chunks))); })
      .expect(200);
    expect(file.body.toString()).toBe('database one');
    expect(file.headers['content-disposition']).toBe('attachment; filename="db_2031-03-01_0200.dump"');
    expect(file.headers['cache-control']).toContain('no-store');
    const audit = await select<{ details: { file: string } }>(
      "SELECT details FROM audit_logs WHERE action = 'backup.downloaded' AND user_id = :id", { id: owner.user.id });
    expect(audit.map((row) => row.details.file)).toContain('db_2031-03-01_0200.dump');
    expect((await api().get('/api/owner/backups').set(owner.auth).expect(200)).body.data.lastDownload).not.toBeNull();

    for (const name of ['notes.txt', 'db_2031-03-01_0200.dump.bak', 'db_2031-03-09_0200.dump', 'db_2031-03-01_0200.DUMP']) {
      const refused = await api().get(`/api/owner/backups/${name}`).set(owner.auth);
      expect(refused.status, name).toBe(404);
    }
    // A path outside the folder: the firewall stops it first (403), and the name check would anyway (404).
    for (const name of ['..%2Fdb_2031-03-01_0300.dump', '%2Fetc%2Fpasswd']) {
      const outside = await api().get(`/api/owner/backups/${name}`).set(owner.auth);
      expect([403, 404], name).toContain(outside.status);
      expect(JSON.stringify(outside.body)).not.toContain('outside the folder');
    }
  });

  it('reminds the owner once a week until a copy is downloaded', async () => {
    process.env.BACKUP_DIR = dir;
    // The last download was today; years later (a Wednesday, then the Thursday) the reminder is due once that week.
    const first = await runHrReminders(new Date('2031-03-05T09:00:00Z'));
    expect(first.backup_offsite).toBe(1);
    const again = await runHrReminders(new Date('2031-03-06T09:00:00Z'));
    expect(again.backup_offsite).toBeUndefined();
    const notice = await selectOne<{ title: string; link: string }>(
      "SELECT title, link FROM notifications WHERE user_id = :id AND kind = 'backup' ORDER BY created_at DESC LIMIT 1", { id: owner.user.id });
    expect(notice).toEqual({ title: 'نزّل نسخة احتياطية خارج السيرفر', link: '/owner' });
    // Downloaded recently: no reminder.
    const soon = await runHrReminders(new Date(Date.now() + 86400000));
    expect(soon.backup_offsite).toBeUndefined();
  });
});
