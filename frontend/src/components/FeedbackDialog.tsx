import { FormEvent, useEffect, useState } from 'react';
import { Bug, HelpCircle, ImagePlus, Lightbulb, Send, X } from 'lucide-react';
import { APP_VERSION, versionLabel } from '../lib/releases';
import { formatDateTime } from '../lib/format';
import { useSession } from '../lib/session';
import { Dialog, StatusTag } from './ui';

type Kind = 'bug' | 'idea' | 'question';
interface Mine { id: string; refNo: string; kind: Kind; message: string; status: string; ownerNote: string | null; createdAt: string }

const KINDS: Array<{ id: Kind; label: string; hint: string; icon: typeof Bug }> = [
  { id: 'bug', label: 'خطأ أو شيء لا يعمل', hint: 'ماذا فعلت، وماذا ظهر بدل المتوقع؟', icon: Bug },
  { id: 'idea', label: 'اقتراح', hint: 'ما الذي يجعل عملك أسهل أو أسرع؟', icon: Lightbulb },
  { id: 'question', label: 'سؤال', hint: 'عن أي شاشة أو خطوة تسأل؟', icon: HelpCircle },
];
export const FEEDBACK_STATUS: Record<string, { label: string; tone: string }> = {
  new: { label: 'وصلت', tone: 'info' }, in_progress: { label: 'قيد المعالجة', tone: 'warn' },
  done: { label: 'تمت', tone: 'good' }, declined: { label: 'لن تُنفّذ', tone: 'muted' },
};

/** «ملاحظة على النظام»: a fault, an idea or a question, sent with the screen it came from. */
export function FeedbackDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const session = useSession();
  const [kind, setKind] = useState<Kind>('bug');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [mine, setMine] = useState<Mine[]>([]);
  const page = window.location.hash.replace(/^#/, '') || '/home';

  useEffect(() => {
    if (!open) return;
    session.call<{ data: Mine[] }>('/feedback/mine', { background: true }).then((result) => setMine(result.data)).catch(() => setMine([]));
  }, [open, session]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const form = new FormData();
    form.append('kind', kind);
    form.append('message', String(data.get('message') ?? ''));
    form.append('page', page.slice(0, 200));
    form.append('appVersion', APP_VERSION);
    form.append('viewport', `${window.innerWidth}x${window.innerHeight}`);
    if (file) form.append('file', file);
    setBusy(true);
    try {
      const result = await session.call<{ data: { refNo: string } }>('/feedback', { form });
      session.notify(`وصلت ملاحظتك ${result.data.refNo}. تُبلَّغ حين تُعالج.`);
      setFile(null);
      onClose();
    } catch (error) {
      session.fail(error, 'تعذر إرسال الملاحظة.');
    } finally {
      setBusy(false);
    }
  }

  const current = KINDS.find((item) => item.id === kind)!;
  return (
    <Dialog open={open} title="ملاحظة على النظام · Feedback" subtitle="تصل لمالك النظام مع اسم الشاشة ورقم الإصدار ونوع جهازك." onClose={onClose}>
      {open && <form onSubmit={(event) => void submit(event)}>
        <div className="feedback-kinds" role="radiogroup" aria-label="نوع الملاحظة">
          {KINDS.map((item) => { const Icon = item.icon; return <button key={item.id} type="button" role="radio" aria-checked={kind === item.id} className={kind === item.id ? 'is-active' : ''} onClick={() => setKind(item.id)}><Icon size={18} />{item.label}</button>; })}
        </div>
        <label className="field"><span>{current.hint} *</span><textarea name="message" required minLength={3} maxLength={2000} rows={5} /></label>
        <div className="feedback-attach">
          {file ? <span className="feedback-file"><ImagePlus size={15} />{file.name}<button type="button" className="icon-button" aria-label="إزالة الصورة" onClick={() => setFile(null)}><X size={14} /></button></span>
            : <label className="button button-quiet button-small file-button"><ImagePlus size={14} />إرفاق لقطة شاشة<input type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(event) => setFile(event.target.files?.[0] ?? null)} /></label>}
          <small className="muted"><span dir="ltr">{page}</span> · {versionLabel(APP_VERSION)} · <span dir="ltr">{window.innerWidth}×{window.innerHeight}</span></small>
        </div>
        <div className="dialog-actions"><button className="button button-primary" disabled={busy}><Send size={15} />{busy ? 'جارٍ الإرسال…' : 'إرسال'}</button><button type="button" className="button button-quiet" onClick={onClose}>إلغاء</button></div>
        {mine.length > 0 && <div className="feedback-mine">
          <h4>ملاحظاتي السابقة</h4>
          {mine.slice(0, 5).map((item) => <div key={item.id} className="feedback-mine-row">
            <span><strong dir="ltr">{item.refNo}</strong> <StatusTag map={FEEDBACK_STATUS} value={item.status} /></span>
            <p>{item.message.length > 120 ? `${item.message.slice(0, 120)}…` : item.message}</p>
            {item.ownerNote && <p className="feedback-reply">الرد: {item.ownerNote}</p>}
            <small className="muted">{formatDateTime(item.createdAt)}</small>
          </div>)}
        </div>}
      </form>}
    </Dialog>
  );
}
