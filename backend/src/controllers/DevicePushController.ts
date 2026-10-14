import { Request, Response } from 'express';
import { execute, selectOne } from '../db/query';
import { ingestPunches, recomputeAfterIngest, RawPunch } from '../services/attendance';
import { parseDateTime } from '../services/punchParser';

/**
 * Receiver for the ZKTeco "ADMS" push protocol (/iclock/*). Devices are
 * pointed at this server and upload ATTLOG lines; only registered, active
 * serial numbers are accepted, optionally restricted to an IP allowlist.
 * The protocol has no credentials of its own, so the allowlist (or a VPN
 * between branches and the server) is the recommended protection.
 */

interface DeviceRow {
  id: string;
  ipAllowlist: string | null;
}

function ipToNumber(ip: string): number | null {
  const parts = ip.replace(/^::ffff:/, '').split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

export function ipAllowed(ip: string, allowlist: string | null): boolean {
  if (!allowlist) return true;
  const address = ipToNumber(ip);
  return allowlist.split(',').map((item) => item.trim()).filter(Boolean).some((entry) => {
    const [base, bits] = entry.split('/');
    if (bits === undefined) return base === ip.replace(/^::ffff:/, '');
    const network = ipToNumber(base);
    const prefix = Number(bits);
    if (address === null || network === null || prefix < 0 || prefix > 32) return false;
    const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
    return (address & mask) === (network & mask);
  });
}

async function authorizedDevice(req: Request, res: Response): Promise<DeviceRow | null> {
  const serial = typeof req.query.SN === 'string' ? req.query.SN.trim() : '';
  const device = serial && /^[A-Za-z0-9_-]{1,60}$/.test(serial)
    ? await selectOne<DeviceRow>(
      'SELECT id, ip_allowlist AS "ipAllowlist" FROM attendance_devices WHERE serial_no = :serial AND is_active',
      { serial },
    )
    : null;
  if (!device || !ipAllowed(req.ip || '', device.ipAllowlist)) {
    res.status(403).type('text/plain').send('ERROR: device not registered');
    return null;
  }
  await execute('UPDATE attendance_devices SET last_seen_at = now() WHERE id = :id', { id: device.id });
  return device;
}

export function parseAttlog(text: string): { punches: RawPunch[]; invalid: number } {
  const punches: RawPunch[] = [];
  let invalid = 0;
  for (const line of text.replace(/\r/g, '').split('\n')) {
    if (!line.trim()) continue;
    const [pinField, at] = line.split('\t');
    const pin = (pinField || '').trim().replace(/^0+(?=\d)/, '');
    const parsed = parseDateTime(at || '', 'dmy');
    if (/^[A-Za-z0-9_-]{1,40}$/.test(pin) && parsed) punches.push({ pin, at: parsed });
    else invalid += 1;
  }
  return { punches, invalid };
}

export class DevicePushController {
  /** Initial handshake: the device asks for its upload options. */
  static async handshake(req: Request, res: Response): Promise<void> {
    const device = await authorizedDevice(req, res);
    if (!device) return;
    res.type('text/plain').send([
      `GET OPTION FROM: ${req.query.SN}`,
      'ATTLOGStamp=None',
      'OPERLOGStamp=9999',
      'ATTPHOTOStamp=None',
      'ErrorDelay=60',
      'Delay=30',
      'TransTimes=00:00;12:00',
      'TransInterval=1',
      'TransFlag=TransData AttLog',
      'TimeZone=3',
      'Realtime=1',
      'Encrypt=None',
    ].join('\n'));
  }

  static async upload(req: Request, res: Response): Promise<void> {
    const device = await authorizedDevice(req, res);
    if (!device) return;
    const table = typeof req.query.table === 'string' ? req.query.table.toUpperCase() : '';
    const text = typeof req.body === 'string' ? req.body : '';
    if (table !== 'ATTLOG') {
      // Operation logs, user lists and photos are acknowledged and ignored.
      res.type('text/plain').send('OK');
      return;
    }
    const { punches, invalid } = parseAttlog(text);
    if (!punches.length) {
      res.type('text/plain').send(`OK: 0`);
      return;
    }
    const result = await ingestPunches(punches, { source: 'device', deviceId: device.id, invalid });
    const latest = punches.map((item) => item.at).sort().at(-1);
    await execute(
      'UPDATE attendance_devices SET last_punch_at = GREATEST(COALESCE(last_punch_at, :at), :at) WHERE id = :id',
      { id: device.id, at: latest },
    );
    // Recalculation must not delay the acknowledgement the device waits for.
    void recomputeAfterIngest(result).catch((error: unknown) => {
      console.error('Attendance recompute after device upload failed:', error instanceof Error ? error.message : error);
    });
    res.type('text/plain').send(`OK: ${punches.length}`);
  }

  /** Command polling; this server never queues device commands. */
  static async poll(req: Request, res: Response): Promise<void> {
    const device = await authorizedDevice(req, res);
    if (!device) return;
    res.type('text/plain').send('OK');
  }
}

export default DevicePushController;
