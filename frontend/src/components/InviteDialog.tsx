import { useEffect, useState } from 'react';
import { Copy, Mail, MessageCircle, Send, Smartphone } from 'lucide-react';
import { Dialog } from './ui';
import { useSession } from '../lib/session';

export interface InviteTarget { name: string; login: string; url: string; kind: 'portal' | 'staff'; phone?: string | null; email?: string | null }

/**
 * Sends an account invitation by WhatsApp, SMS or e-mail. The bilingual text
 * comes from the server; on channels the owner enabled it is sent
 * automatically, otherwise the buttons open WhatsApp / Messages / Mail ready to send.
 */
export function InviteDialog({ target, onClose }: { target: InviteTarget | null; onClose: () => void }) {
  const session = useSession();
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [result, setResult] = useState<{ body: string; queued: number; disabledChannels: string[]; links: { whatsapp: string | null; sms: string | null; email: string | null } } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setPhone(target?.phone ?? ''); setEmail(target?.email && !target.email.endsWith('@portal.local') ? target.email : ''); setResult(null); }, [target]);

  async function prepare(channels: string[]) {
    if (!target) return null;
    setBusy(true);
    try {
      const response = await session.call<{ data: NonNullable<typeof result> }>('/invites/deliver', { method: 'POST', body: {
        link: target.url, name: target.name, login: target.login, kind: target.kind, phone: phone || null, email: email || null, channels,
      } });
      setResult(response.data);
      return response.data;
    } catch (error) { session.fail(error, 'تعذر تجهيز الدعوة.'); return null; } finally { setBusy(false); }
  }
  async function open(channel: 'whatsapp' | 'sms' | 'email') {
    const prepared = await prepare([channel]);
    if (!prepared) return;
    if (prepared.queued) { session.notify('أُرسلت الدعوة تلقائياً عبر القناة المفعّلة.'); return; }
    const link = prepared.links[channel];
    if (link) window.open(link, channel === 'whatsapp' ? '_blank' : '_self');
    else session.notify(channel === 'email' ? 'أدخل البريد الإلكتروني.' : 'أدخل رقم الهاتف.', true);
  }

  return (
    <Dialog open={Boolean(target)} title={target?.kind === 'staff' ? 'دعوة مستخدم · Invite user' : 'دعوة لبوابة الموظف · Portal invitation'}
      subtitle={target ? `${target.name} · يدخل بـ ${target.login} · الرابط صالح 7 أيام ولمرة واحدة` : ''} onClose={onClose}>
      {target && <div className="invite-link">
        <div className="form-grid">
          <label className="field"><span>رقم الهاتف (واتساب / رسالة نصية)</span><input dir="ltr" value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="07XX XXX XXXX" /></label>
          <label className="field"><span>البريد الإلكتروني</span><input dir="ltr" type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.com" /></label>
        </div>
        <div className="invite-actions">
          <button className="button invite-whatsapp" disabled={busy || !phone} onClick={() => void open('whatsapp')}><MessageCircle size={16} />واتساب · WhatsApp</button>
          <button className="button button-quiet" disabled={busy || !phone} onClick={() => void open('sms')}><Smartphone size={16} />رسالة نصية · SMS</button>
          <button className="button button-quiet" disabled={busy || !email} onClick={() => void open('email')}><Mail size={16} />بريد · E-mail</button>
          <button className="button button-quiet" disabled={busy} onClick={async () => { const prepared = result ?? await prepare([]); if (prepared) { await navigator.clipboard.writeText(prepared.body); session.notify('نُسخت الرسالة.'); } }}><Copy size={16} />نسخ</button>
        </div>
        {result && <>
          <textarea readOnly rows={8} value={result.body} />
          {result.queued > 0 ? <p className="good-text"><Send size={13} /> أُرسلت تلقائياً.</p>
            : result.disabledChannels.length > 0 && <p className="muted small">الإرسال التلقائي لهذه القناة غير مفعّل؛ فُتح التطبيق على جهازك والرسالة جاهزة، اضغط إرسال. يفعّله مالك النظام من «لوحة المالك ← القنوات».</p>}
        </>}
      </div>}
    </Dialog>
  );
}
