import { Bi } from './Brand';
import { useEffect, useState } from 'react';
import { Copy, Mail, MessageCircle, Send, Smartphone } from 'lucide-react';
import { Dialog } from './ui';
import { useSession } from '../lib/session';

export interface InviteTarget { name: string; login: string; url: string; kind: 'portal' | 'staff' | 'demo'; phone?: string | null; email?: string | null }

/**
 * Sends an account invitation by WhatsApp, SMS or e-mail. The bilingual text
 * comes from the server; on channels the owner enabled it is sent
 * automatically, otherwise the buttons open WhatsApp / Messages / Mail ready to send.
 */
export function InviteDialog({ target, onClose }: { target: InviteTarget | null; onClose: () => void }) {
  const session = useSession();
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [channel, setChannel] = useState<'whatsapp' | 'sms' | 'email'>('whatsapp');
  const [text, setText] = useState('');
  const [original, setOriginal] = useState('');
  const [subject, setSubject] = useState('');
  const [result, setResult] = useState<Delivery | null>(null);
  const [busy, setBusy] = useState(false);

  async function deliver(channels: string[], customBody?: string): Promise<Delivery | null> {
    if (!target) return null;
    setBusy(true);
    try {
      const response = await session.call<{ data: Delivery }>('/invites/deliver', { method: 'POST', body: {
        link: target.url, name: target.name, login: target.login, kind: target.kind, phone: phone || null, email: email || null, channels,
        ...(customBody ? { customBody } : {}),
      } });
      return response.data;
    } catch (error) { session.fail(error, 'تعذر تجهيز الدعوة.'); return null; } finally { setBusy(false); }
  }

  useEffect(() => {
    const goodEmail = target?.email && !target.email.endsWith('@portal.local') ? target.email : '';
    setPhone(target?.phone ?? ''); setEmail(goodEmail); setResult(null); setText(''); setOriginal('');
    setChannel(target?.phone ? 'whatsapp' : goodEmail ? 'email' : 'whatsapp');
    if (!target) return;
    // The ready text (Arabic and English, with the sign-in page and the one-time link), for the sender to read and edit.
    void deliver([]).then((preview) => { if (preview) { setText(preview.body); setOriginal(preview.body); setSubject(preview.subject ?? ''); } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  const to = channel === 'email' ? email : phone;
  const linkMissing = Boolean(target && text && !text.includes(target.url));

  async function send() {
    if (!to) { session.notify(channel === 'email' ? 'أدخل البريد الإلكتروني.' : 'أدخل رقم الهاتف.', true); return; }
    const sent = await deliver([channel], text.trim() !== original.trim() ? text.trim() : undefined);
    if (!sent) return;
    setResult(sent);
    if (sent.queued) { session.notify('أُرسلت الدعوة تلقائياً عبر القناة المفعّلة.'); return; }
    const link = sent.links[channel];
    if (link) window.open(link, channel === 'whatsapp' ? '_blank' : '_self');
  }

  const CHANNEL_LABEL = { whatsapp: 'واتساب · WhatsApp', sms: 'رسالة نصية · SMS', email: 'بريد · E-mail' } as const;
  return (
    <Dialog open={Boolean(target)} title={target?.kind === 'staff' ? 'دعوة مستخدم · Invite user' : target?.kind === 'demo' ? 'دعوة لتجربة النظام · Demo invitation' : 'دعوة لبوابة الموظف · Portal invitation'}
      subtitle={target ? `${target.name} · يدخل بـ ${target.login} · الرابط صالح 7 أيام ولمرة واحدة` : ''} onClose={onClose}>
      {target && <div className="invite-link">
        <div className="field"><span><Bi ar={"طريقة الإرسال"} en={"Send by"} /></span><div className="segmented">
          {(['whatsapp', 'sms', 'email'] as const).map((item) => <button key={item} type="button" aria-pressed={channel === item} onClick={() => setChannel(item)}>
            {item === 'whatsapp' ? <MessageCircle size={14} /> : item === 'sms' ? <Smartphone size={14} /> : <Mail size={14} />}{CHANNEL_LABEL[item]}</button>)}
        </div></div>
        <div className="form-grid">
          {channel === 'email'
            ? <label className="field"><span>البريد الإلكتروني</span><input dir="ltr" type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.com" /></label>
            : <label className="field"><span>رقم الهاتف</span><input dir="ltr" value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="07XX XXX XXXX" /></label>}
          {channel === 'email' && subject && <label className="field"><span>الموضوع</span><input readOnly value={subject} /></label>}
        </div>
        <label className="field"><span>نص الرسالة — اقرأه وعدّله قبل الإرسال (فيه رابط الدخول ورابط تعيين كلمة المرور)</span>
          <textarea rows={10} value={text} onChange={(event) => setText(event.target.value)} placeholder={busy ? 'يُجهَّز النص…' : ''} /></label>
        {linkMissing && <p className="bad-text small">يجب أن يبقى رابط تعيين كلمة المرور في النص كما هو.</p>}
        <div className="invite-actions">
          <button className={`button ${channel === 'whatsapp' ? 'invite-whatsapp' : 'button-primary'}`} disabled={busy || !text || linkMissing || !to} onClick={() => void send()}><Send size={16} />إرسال عبر {CHANNEL_LABEL[channel]}</button>
          {text !== original && <button className="button button-quiet" disabled={busy} onClick={() => setText(original)}>استرجاع النص الأصلي</button>}
          <button className="button button-quiet" disabled={!text} onClick={async () => { await navigator.clipboard.writeText(text); session.notify('نُسخت الرسالة.'); }}><Copy size={16} />نسخ</button>
        </div>
        {result && (result.queued > 0 ? <p className="good-text"><Send size={13} /> أُرسلت تلقائياً.</p>
          : result.disabledChannels.length > 0 && <p className="muted small">الإرسال التلقائي لهذه القناة غير مفعّل؛ فُتح التطبيق على جهازك والرسالة جاهزة، اضغط إرسال. يفعّله مالك النظام من «لوحة المالك ← القنوات».</p>)}
      </div>}
    </Dialog>
  );
}

interface Delivery { body: string; subject?: string; queued: number; disabledChannels: string[]; links: { whatsapp: string | null; sms: string | null; email: string | null } }
