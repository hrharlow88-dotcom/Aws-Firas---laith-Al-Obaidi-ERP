import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomInt, randomUUID } from 'node:crypto';
import { crc32, deflateRawSync } from 'node:zlib';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SystemSettings } from '../src/config/systemSettings';
import { selectOne } from '../src/db/query';
import { PHOTO_ZIP_LIMITS, sweepStagedImports } from '../src/services/photoZip';
import { uploadRoot } from '../src/services/storage';
import { api, makeBranch, makeEmployee, makeUser } from './helpers';

/** A ZIP written by hand, so a test can put in exactly what an attacker would: any name, a lying size, an encrypted flag. */
interface ZipInput { name: string; data: Buffer; method?: 0 | 8; declaredSize?: number; encrypted?: boolean; unixMode?: number }
function makeZip(entries: ZipInput[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const method = entry.method ?? 8;
    const body = method === 8 ? deflateRawSync(entry.data) : entry.data;
    const crc = crc32(entry.data);
    const name = Buffer.from(entry.name, 'utf8');
    const flags = 0x0800 | (entry.encrypted ? 0x1 : 0);
    const size = entry.declaredSize ?? entry.data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0x21, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(entry.unixMode ? (3 << 8) | 20 : 20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8); central.writeUInt16LE(method, 10); central.writeUInt16LE(0, 12); central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32); central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36); central.writeUInt32LE(entry.unixMode ? (entry.unixMode << 16) >>> 0 : 0, 38); central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const image = (format: 'jpeg' | 'png' | 'webp', color: string, width = 64, height = 64) =>
  sharp({ create: { width, height, channels: 3, background: color } })[format]().toBuffer();

let owner: Awaited<ReturnType<typeof makeUser>>;
let hr: Awaited<ReturnType<typeof makeUser>>;
let otherHr: Awaited<ReturnType<typeof makeUser>>;
let branchId: string;
let otherBranchId: string;
let original: SystemSettings;
const savedLimits = { ...PHOTO_ZIP_LIMITS };

/** Six digits no other test uses, so numbers like 0NNNNNN and NNNNNN are this file's own. */
const base = String(randomInt(100000, 999999));
const no = (suffix: string) => `${base}${suffix}`;

function preview(user: { auth: Record<string, string> }, zip: Buffer, name = 'photos.zip') {
  return api().post('/api/employees/photos/zip/preview').set(user.auth).attach('file', zip, name);
}

async function photoDocument(employeeId: string) {
  return (await selectOne<{ photoDocumentId: string | null }>('SELECT photo_document_id AS "photoDocumentId" FROM employees WHERE id = :employeeId', { employeeId }))!.photoDocumentId;
}

beforeAll(async () => {
  owner = await makeUser('super_admin');
  hr = await makeUser('hr_manager');
  otherHr = await makeUser('hr_manager');
  branchId = (await makeBranch('فرع صور ZIP')).id;
  otherBranchId = (await makeBranch('فرع آخر للصور')).id;
  original = (await api().get('/api/settings').set(owner.auth).expect(200)).body.data;
});

afterAll(async () => {
  Object.assign(PHOTO_ZIP_LIMITS, savedLimits);
  await api().put('/api/settings').set(owner.auth).send(original).expect(200);
});

describe('employee photos from one ZIP', () => {
  it('matches each photo by the employee number as text, previews before saving, and saves only on confirmation', async () => {
    const withZero = await makeEmployee(branchId, { employeeNo: `0${no('1')}`, fullName: 'موظف برقم يبدأ بصفر' });
    const plain = await makeEmployee(branchId, { employeeNo: no('1'), fullName: 'موظف بنفس الرقم بلا صفر' });
    const pngPerson = await makeEmployee(branchId, { employeeNo: no('2'), fullName: 'صورة PNG' });
    const webpPerson = await makeEmployee(branchId, { employeeNo: no('3'), fullName: 'صورة WebP' });
    const doubled = await makeEmployee(branchId, { employeeNo: no('4'), fullName: 'صورتان لنفس الرقم' });
    const big = await image('jpeg', '#cc3333', 2000, 1500);
    const zip = makeZip([
      { name: `0${no('1')}.jpg`, data: big },
      { name: `صور/${no('1')}.JPEG`, data: await image('jpeg', '#3366cc') },
      { name: `${no('2')}.png`, data: await image('png', '#33aa55') },
      { name: `${no('3')}.webp`, data: await image('webp', '#aa33aa'), method: 0 },
      { name: `${no('4')}.jpg`, data: await image('jpeg', '#999999') },
      { name: `other/${no('4')}.png`, data: await image('png', '#888888') },
      { name: '999999999999.jpg', data: await image('jpeg', '#111111') },
      { name: `${no('5')}.jpg`, data: (await image('jpeg', '#222222')).subarray(0, 120) },
      { name: `${no('6')}.jpg`, data: Buffer.from('not really a picture at all, just text') },
      { name: 'IMG_0001.heic', data: Buffer.from('heic') },
      { name: 'notes.txt', data: Buffer.from('hello') },
      { name: '__MACOSX/._x.jpg', data: Buffer.from('mac') },
      { name: '.DS_Store', data: Buffer.from('mac') },
    ]);
    const response = await preview(hr, zip).expect(200);
    const { importId, items, summary } = response.body.data;
    expect(summary).toEqual({ files: 11, ready: 4, hasPhoto: 0, unmatched: 1, duplicate: 2, invalid: 4, ignored: 2 });
    const byEntry = Object.fromEntries(items.map((item: { entry: string }) => [item.entry, item]));
    expect(byEntry[`0${no('1')}.jpg`].employee.id).toBe(withZero.id);
    expect(byEntry[`صور/${no('1')}.JPEG`].employee.id).toBe(plain.id);
    expect(byEntry[`0${no('1')}.jpg`].status).toBe('ready');
    expect(byEntry[`0${no('1')}.jpg`].thumb).toMatch(/^data:image\/jpeg;base64,/);
    expect(byEntry[`${no('4')}.jpg`].status).toBe('duplicate');
    expect(byEntry[`other/${no('4')}.png`].status).toBe('duplicate');
    expect(byEntry['999999999999.jpg'].status).toBe('unmatched');
    expect(byEntry[`${no('5')}.jpg`].status).toBe('corrupt');
    expect(byEntry[`${no('6')}.jpg`].status).toBe('corrupt');
    expect(byEntry['IMG_0001.heic'].reason).toContain('HEIC');
    expect(byEntry['notes.txt'].status).toBe('not_image');
    // Nothing reached the files yet.
    for (const person of [withZero, plain, pngPerson, webpPerson, doubled]) expect(await photoDocument(person.id)).toBeNull();

    const applied = await api().post(`/api/employees/photos/zip/${importId}/apply`).set(hr.auth).send({}).expect(200);
    expect(applied.body.data.summary).toEqual({ added: 4, replaced: 0, skipped: 3, failed: 4 });
    const failed = applied.body.data.items.filter((item: { result: string }) => item.result === 'failed');
    expect(failed.every((item: { reason: string | null }) => item.reason)).toBe(true);
    for (const person of [withZero, plain, pngPerson, webpPerson]) expect(await photoDocument(person.id)).not.toBeNull();
    expect(await photoDocument(doubled.id)).toBeNull();

    // The stored photo is a JPEG of at most 1024 px, served only within scope, and the thumbnails follow.
    const photo = await api().get(`/api/employees/${withZero.id}/photo`).set(hr.auth).buffer(true).parse((res, done) => {
      const chunks: Buffer[] = []; res.on('data', (chunk: Buffer) => chunks.push(chunk)); res.on('end', () => done(null, Buffer.concat(chunks)));
    }).expect(200);
    expect(photo.headers['content-type']).toBe('image/jpeg');
    const meta = await sharp(photo.body as Buffer).metadata();
    expect([meta.width, meta.height]).toEqual([1024, 768]);
    const thumbs = await api().post('/api/employees/photos/thumbs').set(hr.auth).send({ ids: [withZero.id, pngPerson.id, doubled.id] }).expect(200);
    expect(Object.keys(thumbs.body.data).sort()).toEqual([withZero.id, pngPerson.id].sort());
    expect(thumbs.body.data[withZero.id].v).toBe(await photoDocument(withZero.id));
    expect(thumbs.body.data[withZero.id].src).toMatch(/^data:image\/jpeg;base64,/);

    // The preview is used once.
    await api().post(`/api/employees/photos/zip/${importId}/apply`).set(hr.auth).send({}).expect(410);
    const audit = await selectOne<{ count: number }>(
      "SELECT count(*)::int AS count FROM audit_logs WHERE action = 'employee.photos_zip_imported' AND details->>'importId' = :importId", { importId },
    );
    expect(audit!.count).toBe(1);
  });

  it('keeps current photos unless replacing is chosen, then replaces them', async () => {
    const person = await makeEmployee(branchId, { employeeNo: no('7'), fullName: 'لديه صورة' });
    await api().post(`/api/employees/${person.id}/photo`).set(hr.auth).attach('file', await image('png', '#000000'), 'old.png').expect(201);
    const before = await photoDocument(person.id);
    const zip = makeZip([{ name: `${no('7')}.jpg`, data: await image('jpeg', '#ffcc00') }]);

    const first = await preview(hr, zip).expect(200);
    expect(first.body.data.items[0].status).toBe('has_photo');
    const kept = await api().post(`/api/employees/photos/zip/${first.body.data.importId}/apply`).set(hr.auth).send({}).expect(200);
    expect(kept.body.data.summary).toEqual({ added: 0, replaced: 0, skipped: 1, failed: 0 });
    expect(await photoDocument(person.id)).toBe(before);

    const second = await preview(hr, zip).expect(200);
    await api().post(`/api/employees/photos/zip/${second.body.data.importId}/apply`).set(hr.auth).send({ replace: 'yes' }).expect(400);
    const replaced = await api().post(`/api/employees/photos/zip/${second.body.data.importId}/apply`).set(hr.auth).send({ replace: true }).expect(200);
    expect(replaced.body.data.summary).toEqual({ added: 0, replaced: 1, skipped: 0, failed: 0 });
    const after = await photoDocument(person.id);
    expect(after).not.toBe(before);
    const old = await selectOne<{ deletedAt: string | null }>('SELECT deleted_at AS "deletedAt" FROM employee_documents WHERE id = :id', { id: before });
    expect(old!.deletedAt).not.toBeNull();
  });

  it('never reaches employees outside the uploader\'s scope, and a preview belongs to the person who made it', async () => {
    await api().put('/api/settings').set(owner.auth).send({
      ...original,
      roles: { ...original.roles, branch_manager: { ...original.roles.branch_manager, permissions: [...original.roles.branch_manager.permissions, 'employees.manage_profile'] } },
    }).expect(200);
    const manager = await makeUser('branch_manager', branchId);
    const mine = await makeEmployee(branchId, { employeeNo: no('8'), fullName: 'في فرعي' });
    const theirs = await makeEmployee(otherBranchId, { employeeNo: no('9'), fullName: 'اسم في فرع آخر' });
    const zip = makeZip([
      { name: `${no('8')}.jpg`, data: await image('jpeg', '#123456') },
      { name: `${no('9')}.jpg`, data: await image('jpeg', '#654321') },
    ]);
    const response = await preview(manager, zip).expect(200);
    expect(response.body.data.items.map((item: { status: string }) => item.status)).toEqual(['ready', 'unmatched']);
    expect(JSON.stringify(response.body)).not.toContain('اسم في فرع آخر');

    // Someone else cannot confirm or cancel this preview.
    const importId = response.body.data.importId;
    await api().post(`/api/employees/photos/zip/${importId}/apply`).set(otherHr.auth).send({}).expect(410);
    await api().delete(`/api/employees/photos/zip/${importId}`).set(otherHr.auth).expect(200).expect((res) => expect(res.body.data.discarded).toBe(false));
    const applied = await api().post(`/api/employees/photos/zip/${importId}/apply`).set(manager.auth).send({}).expect(200);
    expect(applied.body.data.summary).toEqual({ added: 1, replaced: 0, skipped: 1, failed: 0 });
    expect(await photoDocument(mine.id)).not.toBeNull();
    expect(await photoDocument(theirs.id)).toBeNull();
    const thumbs = await api().post('/api/employees/photos/thumbs').set(manager.auth).send({ ids: [mine.id, theirs.id] }).expect(200);
    expect(Object.keys(thumbs.body.data)).toEqual([mine.id]);

    const employeeUser = await makeUser('employee', null, mine.id);
    await preview(employeeUser, zip).expect(403);
    await api().put('/api/settings').set(owner.auth).send(original).expect(200);
  });

  it('refuses a whole archive with unsafe paths or programs, and keeps nothing from it', async () => {
    const photo = await image('jpeg', '#abcdef');
    const attempts: Array<[ZipInput[], RegExp]> = [
      [[{ name: `../${no('1')}.jpg`, data: photo }], /مسارات غير آمنة/],
      [[{ name: `/etc/${no('1')}.jpg`, data: photo }], /مسارات غير آمنة/],
      [[{ name: `..\\..\\${no('1')}.jpg`, data: photo }], /مسارات غير آمنة/],
      [[{ name: `${no('1')}.jpg`, data: photo }, { name: 'setup.exe', data: Buffer.from('MZ\x90\x00') }], /ملفاً تنفيذياً/],
      [[{ name: `${no('1')}.jpg`, data: Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200)]) }], /ملفاً تنفيذياً باسم صورة/],
      [[{ name: 'run.sh', data: Buffer.from('#!/bin/sh\necho') }], /ملفاً تنفيذياً/],
    ];
    for (const [entries, message] of attempts) {
      const response = await preview(hr, makeZip(entries)).expect(400);
      expect(response.body.message).toMatch(message);
    }
    await preview(hr, await image('png', '#000000'), 'photos.zip').expect(400).expect((res) => expect(res.body.message).toContain('ليس ملفاً مضغوطاً'));
    await preview(hr, Buffer.from('PK\x03\x04 broken'), 'broken.zip').expect(400);
  });

  it('holds its limits while reading, whatever the archive claims', async () => {
    const zeros = Buffer.alloc(16 * 1024 * 1024);
    const lying = await preview(hr, makeZip([{ name: `${no('1')}.jpg`, data: zeros, declaredSize: 1024 }])).expect(200);
    expect(lying.body.data.items[0].status).toBe('corrupt');
    const honest = await preview(hr, makeZip([{ name: `${no('1')}.jpg`, data: zeros }])).expect(200);
    expect(honest.body.data.items[0].status).toBe('too_large');
    const locked = await preview(hr, makeZip([{ name: `${no('1')}.jpg`, data: await image('jpeg', '#000000'), encrypted: true }])).expect(200);
    expect(locked.body.data.items[0].status).toBe('encrypted');
    const link = await preview(hr, makeZip([{ name: `${no('1')}.jpg`, data: Buffer.from('/etc/passwd'), unixMode: 0o120777 }])).expect(200);
    expect(link.body.data.items[0].status).toBe('not_image');

    const photos = await Promise.all(['#101010', '#202020', '#303030', '#404040'].map((color) => image('jpeg', color)));
    PHOTO_ZIP_LIMITS.images = 3;
    await preview(hr, makeZip(photos.map((data, index) => ({ name: `${no(String(index))}x.jpg`, data })))).expect(400)
      .expect((res) => expect(res.body.message).toContain('أكثر من 3 صورة'));
    PHOTO_ZIP_LIMITS.images = savedLimits.images;
    PHOTO_ZIP_LIMITS.totalBytes = photos[0].length * 2;
    await preview(hr, makeZip(photos.map((data, index) => ({ name: `${no(String(index))}y.jpg`, data })))).expect(400)
      .expect((res) => expect(res.body.message).toContain('بعد فك الضغط'));
    PHOTO_ZIP_LIMITS.totalBytes = savedLimits.totalBytes;
    PHOTO_ZIP_LIMITS.entries = 2;
    await preview(hr, makeZip(photos.map((data, index) => ({ name: `${no(String(index))}z.jpg`, data })))).expect(400);
    PHOTO_ZIP_LIMITS.entries = savedLimits.entries;
  });

  it('removes previews that were cancelled or never confirmed', async () => {
    const zip = makeZip([{ name: `${no('1')}.jpg`, data: await image('jpeg', '#00ff00') }]);
    const cancelled = (await preview(hr, zip).expect(200)).body.data.importId;
    await api().delete(`/api/employees/photos/zip/${cancelled}`).set(hr.auth).expect(200).expect((res) => expect(res.body.data.discarded).toBe(true));
    await api().post(`/api/employees/photos/zip/${cancelled}/apply`).set(hr.auth).send({}).expect(410);

    const forgotten = (await preview(hr, zip).expect(200)).body.data.importId;
    const folder = path.join(uploadRoot(), 'photo-imports', forgotten);
    const old = new Date(Date.now() - 3 * 3600_000);
    await fsp.utimes(folder, old, old);
    expect(await sweepStagedImports()).toBeGreaterThanOrEqual(1);
    await expect(fsp.stat(folder)).rejects.toThrow();
    await api().post(`/api/employees/photos/zip/${forgotten}/apply`).set(hr.auth).send({}).expect(410);
    await api().post(`/api/employees/photos/zip/${randomUUID()}/apply`).set(hr.auth).send({}).expect(410);
  });
});
