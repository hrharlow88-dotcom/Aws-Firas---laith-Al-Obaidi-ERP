import { ReactNode, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Plus, X } from 'lucide-react';
import { BiText } from './Brand';

export function Tone({ tone, children }: { tone: string; children: ReactNode }) {
  return <span className={`tone tone-${tone}`}><i />{children}</span>;
}

export function StatusTag({ map, value }: { map: Record<string, { label: string; tone: string }>; value: string }) {
  const entry = map[value] ?? { label: value, tone: 'muted' };
  return <Tone tone={entry.tone}><BiText text={entry.label} /></Tone>;
}

export function Tabs<T extends string>({ value, items, onChange }: {
  value: T;
  items: Array<{ id: T; label: string; badge?: number }>;
  onChange: (value: T) => void;
}) {
  return (
    <nav className="tabs" role="tablist">
      {items.map((item) => (
        <button
          key={item.id}
          role="tab"
          aria-selected={value === item.id}
          className={`tab ${value === item.id ? 'tab-active' : ''}`}
          onClick={() => onChange(item.id)}
        >
          <BiText text={item.label} />
          {item.badge ? <span className="tab-badge">{item.badge > 99 ? '99+' : item.badge}</span> : null}
        </button>
      ))}
    </nav>
  );
}

export function Empty({ icon, title, text, action, onAction }: {
  icon: ReactNode;
  title: string;
  text: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">{icon}</span>
      <strong><BiText text={title} /></strong>
      <p><BiText text={text} /></p>
      {action && onAction && <button className="button button-quiet" onClick={onAction}><Plus size={16} />{action}</button>}
    </div>
  );
}

export function Loading({ label = 'جارٍ التحميل…' }: { label?: string }) {
  return <div className="loading-row" role="status"><span className="spinner" />{label}</div>;
}

export function Stat({ label, value, foot, tone }: { label: string; value: ReactNode; foot?: ReactNode; tone?: string }) {
  return (
    <div className={`stat ${tone ? `stat-${tone}` : ''}`}>
      <span className="stat-label"><BiText text={label} /></span>
      <strong>{value}</strong>
      {foot && <span className="stat-foot">{foot}</span>}
    </div>
  );
}

export function Warning({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="callout callout-warn">
      <AlertTriangle size={17} />
      <div><strong><BiText text={title} /></strong><span>{children}</span></div>
    </div>
  );
}

/** A dialog built on <dialog> so focus, Escape and the backdrop behave natively. */
export function Dialog({ open, title, subtitle, onClose, children, wide, sheet }: {
  open: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  /** On phones: a sheet rising from the bottom instead of a full screen. */
  sheet?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={`dialog ${wide ? 'dialog-wide' : ''} ${sheet ? 'dialog-sheet' : ''}`}
      onClose={onClose}
      onClick={(event) => { if (event.target === ref.current) onClose(); }}
    >
      {open && <>
        <div className="dialog-head">
          <div><h3><BiText text={title} /></h3>{subtitle && <p><BiText text={subtitle} /></p>}</div>
          <button className="icon-button" type="button" aria-label="إغلاق" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="dialog-body">{children}</div>
      </>}
    </dialog>
  );
}

/** Asks for a mandatory reason before a sensitive action. */
export function useReasonPrompt() {
  const [state, setState] = useState<{ title: string; resolve: (reason: string | null) => void } | null>(null);
  const [reason, setReason] = useState('');
  const ask = (title: string) => new Promise<string | null>((resolve) => {
    setReason('');
    setState({ title, resolve });
  });
  const close = (value: string | null) => {
    state?.resolve(value);
    setState(null);
  };
  const element = (
    <Dialog open={Boolean(state)} title={state?.title ?? ''} subtitle="يُسجل السبب في سجل التدقيق." onClose={() => close(null)}>
      <form onSubmit={(event) => { event.preventDefault(); if (reason.trim()) close(reason.trim()); }}>
        <label className="field"><span>السبب *</span><textarea rows={3} required maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} autoFocus /></label>
        <div className="dialog-actions">
          <button className="button button-primary" type="submit" disabled={!reason.trim()}>تأكيد</button>
          <button className="button button-quiet" type="button" onClick={() => close(null)}>إلغاء</button>
        </div>
      </form>
    </Dialog>
  );
  return { ask, element };
}

export function PersonCell({ name, sub, photoUrl }: { name: string; sub?: ReactNode; photoUrl?: string | null }) {
  return (
    <span className="person-cell">
      {photoUrl ? <img className="person-photo" src={photoUrl} alt="" /> : <span className="person-mark">{name.slice(0, 1)}</span>}
      <span><strong>{name}</strong>{sub && <small>{sub}</small>}</span>
    </span>
  );
}
