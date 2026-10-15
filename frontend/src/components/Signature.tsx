import { PointerEvent, useEffect, useRef, useState } from 'react';
import { Check, Eraser, PenLine } from 'lucide-react';
import { useLoad, useSession } from '../lib/session';

/**
 * Draw-your-signature pad. The drawing is kept as a PNG; approvals copy it
 * at the moment of signing, so changing it later does not alter past approvals.
 */
export function SignaturePad({ onSave }: { onSave: (image: string) => Promise<void> }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [empty, setEmpty] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const element = canvas.current!;
    const ratio = window.devicePixelRatio || 1;
    element.width = element.offsetWidth * ratio;
    element.height = element.offsetHeight * ratio;
    const context = element.getContext('2d')!;
    context.scale(ratio, ratio);
    context.lineWidth = 2.4;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.strokeStyle = '#1a2a6c';
  }, []);

  const point = (event: PointerEvent<HTMLCanvasElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };
  const start = (event: PointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    drawing.current = true;
    const { x, y } = point(event);
    const context = event.currentTarget.getContext('2d')!;
    context.beginPath();
    context.moveTo(x, y);
  };
  const move = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const { x, y } = point(event);
    const context = event.currentTarget.getContext('2d')!;
    context.lineTo(x, y);
    context.stroke();
    setEmpty(false);
  };
  const clear = () => {
    const element = canvas.current!;
    element.getContext('2d')!.clearRect(0, 0, element.width, element.height);
    setEmpty(true);
  };
  async function save() {
    setBusy(true);
    try { await onSave(canvas.current!.toDataURL('image/png')); clear(); } finally { setBusy(false); }
  }

  return (
    <div className="signature-pad">
      <canvas ref={canvas} onPointerDown={start} onPointerMove={move} onPointerUp={() => { drawing.current = false; }} onPointerLeave={() => { drawing.current = false; }} aria-label="مساحة رسم التوقيع · Signature area" />
      <div className="signature-actions">
        <span className="muted"><PenLine size={14} />ارسم توقيعك بالماوس أو بالإصبع · Draw your signature</span>
        <button type="button" className="button button-quiet" onClick={clear}><Eraser size={15} />مسح</button>
        <button type="button" className="button button-primary" disabled={empty || busy} onClick={() => void save()}><Check size={15} />حفظ التوقيع</button>
      </div>
    </div>
  );
}

/** The signed-in person's saved signature with the pad to replace it. */
export function MySignature() {
  const session = useSession();
  const signature = useLoad<{ image: string | null }>('/auth/signature', { image: null });
  return (
    <section className="panel">
      <div className="panel-head"><div><h3>توقيعي الإلكتروني · My e-signature</h3><p>يُستخدم في اعتماد المسيرات والطلبات. كل اعتماد يحفظ نسخة من التوقيع وقت التوقيع.</p></div></div>
      {signature.data.image && <div className="signature-current"><img src={signature.data.image} alt="التوقيع الحالي" /><span className="muted">التوقيع المحفوظ حالياً</span></div>}
      <SignaturePad onSave={async (image) => {
        try {
          await session.call('/auth/signature', { method: 'PUT', body: { image } });
          session.notify('حُفظ توقيعك الإلكتروني.');
          signature.reload();
        } catch (error) {
          session.fail(error, 'تعذر حفظ التوقيع.');
        }
      }} />
    </section>
  );
}
