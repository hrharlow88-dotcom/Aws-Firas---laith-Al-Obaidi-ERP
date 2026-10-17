import { useEffect, useState } from 'react';
import { Bug, HelpCircle, ImageIcon, Lightbulb, MessageSquarePlus, RefreshCw, Save } from 'lucide-react';
import { Bi } from '../components/Brand';
import { Empty, Loading, StatusTag, Tabs } from '../components/ui';
import { apiBlob, openFile } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { useLoad, useSession } from '../lib/session';

type Status = 'new' | 'in_progress' | 'done' | 'declined';
interface Note {
  id: string; refNo: string; kind: 'bug' | 'idea' | 'question'; message: string; page: string | null; appVersion: string | null;
  device: string | null; viewport: string | null; hasImage: boolean; status: Status; ownerNote: string | null;
  createdAt: string; updatedAt: string; userName: string; userRole: string;
}

const STATUS: Record<Status, { label: string; tone: string }> = {
  new: { label: 'جديدة', tone: 'info' }, in_progress: { label: 'قيد المعالجة', tone: 'warn' },
  done: { label: 'تمت', tone: 'good' }, declined: { label: 'لن تُنفّذ', tone: 'muted' },
};
const KIND = {
  bug: { label: 'خطأ', icon: Bug }, idea: { label: 'اقتراح', icon: Lightbulb }, question: { label: 'سؤال', icon: HelpCircle },
};

function deviceName(agent: string | null): string {
  if (!agent) return '';
  const os = /iphone/i.test(agent) ? 'iPhone' : /ipad/i.test(agent) ? 'iPad' : /android/i.test(agent) ? 'Android' : /windows/i.test(agent) ? 'Windows' : /mac os/i.test(agent) ? 'Mac' : /linux/i.test(agent) ? 'Linux' : '';
  const browser = /edg\//i.test(agent) ? 'Edge' : /crios|chrome\//i.test(agent) ? 'Chrome' : /fxios|firefox\//i.test(agent) ? 'Firefox' : /safari\//i.test(agent) ? 'Safari' : '';
  return [os, browser].filter(Boolean).join(' / ');
}

/** «ملاحظات المستخدمين»: every fault, idea and question sent from «ملاحظة على النظام», for the owner to work through and answer. */
export function FeedbackPage() {
  const [tab, setTab] = useState<Status | 'all'>('new');
  const list = useLoad<{ rows: Note[]; counts: Partial<Record<Status, number>> }>(`/feedback${tab === 'all' ? '' : `?status=${tab}`}`, { rows: [], counts: {} });
  const counts = list.data.counts;
  return (
    <section className="screen">
      <div className="screen-heading"><div><h2><Bi ar="ملاحظات المستخدمين" en="User feedback" /></h2>
        <p>ما يرسله المستخدمون من «ملاحظة على النظام» (في قائمة الحساب، وفي «المزيد» على التلفون): خطأ أو اقتراح أو سؤال، ومعه الشاشة ورقم النسخة والجهاز. غيّر الحالة واكتب رداً، فيصل صاحب الملاحظة إشعار بها.</p></div>
        <button className="button button-quiet" onClick={list.reload}><RefreshCw size={15} />تحديث</button></div>
      <Tabs value={tab} onChange={setTab} items={[
        { id: 'new', label: 'الجديدة · New', badge: counts.new }, { id: 'in_progress', label: 'قيد المعالجة · In progress', badge: counts.in_progress },
        { id: 'done', label: 'تمت · Done' }, { id: 'declined', label: 'لن تُنفّذ · Declined' }, { id: 'all', label: 'الكل · All' },
      ]} />
      {list.loading ? <Loading /> : !list.data.rows.length
        ? <section className="panel"><Empty icon={<MessageSquarePlus size={22} />} title={tab === 'new' ? 'لا ملاحظات جديدة' : 'لا شيء هنا'} text="تظهر هنا الملاحظات حين يرسلها المستخدمون، ويصلك إشعار بكل واحدة." /></section>
        : <div className="feedback-list">{list.data.rows.map((note) => <FeedbackItem key={note.id} note={note} onSaved={list.reload} />)}</div>}
    </section>
  );
}

function FeedbackItem({ note, onSaved }: { note: Note; onSaved: () => void }) {
  const session = useSession();
  const [status, setStatus] = useState<Status>(note.status);
  const [reply, setReply] = useState(note.ownerNote ?? '');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setStatus(note.status); setReply(note.ownerNote ?? ''); }, [note.status, note.ownerNote]);
  const changed = status !== note.status || reply.trim() !== (note.ownerNote ?? '');
  const kind = KIND[note.kind];
  const Icon = kind.icon;
  async function save() {
    setBusy(true);
    try {
      await session.call(`/feedback/${note.id}`, { method: 'PATCH', body: { status, ownerNote: reply.trim() || null } });
      session.notify(`حُفظت ${note.refNo}، ووصل صاحبها إشعار.`);
      onSaved();
    } catch (error) { session.fail(error, 'تعذر الحفظ.'); } finally { setBusy(false); }
  }
  return (
    <article className="panel feedback-item">
      <header>
        <span className={`feedback-kind feedback-kind-${note.kind}`}><Icon size={15} />{kind.label}</span>
        <strong dir="ltr">{note.refNo}</strong>
        <StatusTag map={STATUS} value={note.status} />
        <small className="muted">{formatDateTime(note.createdAt)}</small>
      </header>
      <p className="feedback-who">{note.userName}<span className="muted"> · {(session.settings.roles as Record<string, { label: string } | undefined> | undefined)?.[note.userRole]?.label ?? note.userRole}</span></p>
      <p className="feedback-message">{note.message}</p>
      <div className="feedback-meta">
        {note.page && <span>الشاشة: <code dir="ltr">{note.page}</code></span>}
        {note.appVersion && <span>النسخة: <span dir="ltr">v{note.appVersion}</span></span>}
        {(note.device || note.viewport) && <span>الجهاز: <span dir="ltr">{[deviceName(note.device), note.viewport].filter(Boolean).join(' · ')}</span></span>}
      </div>
      {note.hasImage && <FeedbackImage id={note.id} />}
      <div className="feedback-handle">
        <label className="field"><span>الحالة</span>
          <select value={status} onChange={(event) => setStatus(event.target.value as Status)}>
            {(Object.keys(STATUS) as Status[]).map((key) => <option key={key} value={key}>{STATUS[key].label}</option>)}
          </select></label>
        <label className="field"><span>ردك لصاحب الملاحظة (اختياري)</span>
          <textarea rows={2} maxLength={1000} value={reply} placeholder="مثال: أُصلح في النسخة 2.1، حدّث الصفحة." onChange={(event) => setReply(event.target.value)} /></label>
        <button className="button button-primary" disabled={busy || !changed} onClick={() => void save()}><Save size={15} />{busy ? 'جارٍ الحفظ…' : 'حفظ وإبلاغ'}</button>
      </div>
    </article>
  );
}

function FeedbackImage({ id }: { id: string }) {
  const session = useSession();
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let made: string | null = null;
    let live = true;
    apiBlob(`/feedback/${id}/image`, session.token).then((result) => {
      made = result.url;
      if (live) setUrl(result.url); else URL.revokeObjectURL(result.url);
    }).catch(() => setUrl(null));
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [id, session.token]);
  return (
    <button type="button" className="feedback-shot" title="فتح الصورة بالحجم الكامل" onClick={() => void openFile(`/feedback/${id}/image`, session.token).catch((error) => session.fail(error, 'تعذر فتح الصورة.'))}>
      {url ? <img src={url} alt="لقطة الشاشة المرفقة" /> : <ImageIcon size={20} />}
    </button>
  );
}
