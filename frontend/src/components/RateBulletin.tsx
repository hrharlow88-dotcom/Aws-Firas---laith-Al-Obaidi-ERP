import { FormEvent, useState } from 'react';
import { ArrowDownRight, ArrowUpRight, DollarSign, Minus } from 'lucide-react';
import { formatDate, formatNumber } from '../lib/format';
import { useLoad, useSession } from '../lib/session';

interface RatePoint { date: string; rate: number; note: string | null; setByName: string | null }
export interface Bulletin { latest: RatePoint | null; previous: RatePoint | null; change: number | null; changePercent: number | null; history: RatePoint[] }

/**
 * The daily dollar bulletin: today's dinar rate, the move since the last
 * one, a short trend, and (for payroll and finance) a box to post today's rate.
 */
export function RateBulletin({ compact = false }: { compact?: boolean }) {
  const session = useSession();
  const data = useLoad<Bulletin>('/exchange-rates?days=30', { latest: null, previous: null, change: null, changePercent: null, history: [] });
  const [editing, setEditing] = useState(false);
  const canSet = session.can('payroll.prepare') || session.can('finance.manage');
  const { latest, change, changePercent, history } = data.data;
  const points = [...history].reverse();
  const min = Math.min(...points.map((point) => point.rate));
  const max = Math.max(...points.map((point) => point.rate));
  const path = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${(index / Math.max(points.length - 1, 1)) * 100},${max === min ? 15 : 28 - ((point.rate - min) / (max - min)) * 26}`).join(' ');
  const Trend = change === null || change === 0 ? Minus : change > 0 ? ArrowUpRight : ArrowDownRight;

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await session.call('/exchange-rates', { method: 'POST', body: { rate: Number(form.get('rate')), date: form.get('date') || undefined, note: form.get('note') || null } });
      session.notify('نُشر سعر الصرف.');
      setEditing(false);
      data.reload();
    } catch (error) { session.fail(error, 'تعذر الحفظ.'); }
  }

  return (
    <div className={`rate-bulletin ${compact ? 'rate-bulletin-compact' : ''}`}>
      <span className="rate-icon"><DollarSign size={18} /></span>
      <div className="rate-main">
        <small>سعر صرف الدولار اليوم · USD/IQD</small>
        {latest ? <strong dir="ltr">1 $ = {formatNumber(latest.rate)} د.ع</strong> : <strong>لم يُنشر بعد</strong>}
        {latest && <span className="rate-date">{formatDate(latest.date)}{latest.setByName ? ` · ${latest.setByName}` : ''}</span>}
      </div>
      {change !== null && <span className={`rate-change ${change > 0 ? 'is-up' : change < 0 ? 'is-down' : ''}`}><Trend size={15} />{change > 0 ? '+' : ''}{formatNumber(change)} ({changePercent}%)</span>}
      {points.length > 1 && !compact && <svg className="rate-spark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true"><path d={path} /></svg>}
      {canSet && !compact && (editing
        ? <form className="rate-form" onSubmit={(event) => void save(event)}>
          <input name="rate" type="number" min={100} max={100000} step="0.01" required placeholder="1310" dir="ltr" defaultValue={latest?.rate} />
          <input name="date" type="date" />
          <input name="note" placeholder="ملاحظة (السوق، البنك المركزي…)" maxLength={200} />
          <button className="button button-primary button-small">نشر</button>
          <button type="button" className="button button-quiet button-small" onClick={() => setEditing(false)}>إلغاء</button>
        </form>
        : <button className="button button-quiet button-small" onClick={() => setEditing(true)}>نشر سعر اليوم</button>)}
    </div>
  );
}
