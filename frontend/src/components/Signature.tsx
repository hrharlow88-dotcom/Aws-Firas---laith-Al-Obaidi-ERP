import { Bi } from './Brand';
import { ChangeEvent, PointerEvent, useEffect, useRef, useState } from 'react';
import { Check, Eraser, ImageUp, PenLine, Type } from 'lucide-react';
import '@fontsource/great-vibes';
import '@fontsource/alex-brush';
import '@fontsource/dancing-script/600.css';
import { useLoad, useSession } from '../lib/session';

const INK = '#1a2a6c';
export const SIGNATURE_FONTS = [
  { id: 'Great Vibes', label: 'Great Vibes' },
  { id: 'Alex Brush', label: 'Alex Brush' },
  { id: 'Dancing Script', label: 'Dancing Script' },
];

/** Draws a typed name in a script font as a transparent PNG. */
export async function typedSignature(text: string, font: string): Promise<string> {
  const size = font === 'Dancing Script' ? 64 : 76;
  const weight = font === 'Dancing Script' ? '600 ' : '';
  await document.fonts.load(`${weight}${size}px "${font}"`, text);
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d')!;
  context.font = `${weight}${size}px "${font}"`;
  const width = Math.min(900, Math.ceil(context.measureText(text).width) + 60);
  canvas.width = width;
  canvas.height = 150;
  context.font = `${weight}${size}px "${font}"`;
  context.fillStyle = INK;
  context.textBaseline = 'middle';
  context.fillText(text, 30, 78);
  // A light flourish under the name.
  context.strokeStyle = INK;
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(34, 122);
  context.bezierCurveTo(width * 0.35, 132, width * 0.65, 108, width - 34, 118);
  context.stroke();
  return canvas.toDataURL('image/png');
}

/** An uploaded picture of a signature, scaled down and turned into a PNG (white paper becomes transparent). */
export async function uploadedSignature(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error('الصورة غير صالحة.'));
      element.src = url;
    });
    const scale = Math.min(1, 700 / image.width, 260 / image.height);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    for (let index = 0; index < pixels.data.length; index += 4) {
      const [r, g, b] = [pixels.data[index], pixels.data[index + 1], pixels.data[index + 2]];
      if (r > 225 && g > 225 && b > 225) pixels.data[index + 3] = 0;
    }
    context.putImageData(pixels, 0, 0);
    let result = canvas.toDataURL('image/png');
    // Stay under the server's size limit for a signature image.
    while (result.length > 280000 && canvas.width > 120) {
      const smaller = document.createElement('canvas');
      smaller.width = Math.round(canvas.width * 0.75);
      smaller.height = Math.round(canvas.height * 0.75);
      smaller.getContext('2d')!.drawImage(canvas, 0, 0, smaller.width, smaller.height);
      canvas.width = smaller.width;
      canvas.height = smaller.height;
      canvas.getContext('2d')!.drawImage(smaller, 0, 0);
      result = canvas.toDataURL('image/png');
    }
    return result;
  } finally {
    URL.revokeObjectURL(url);
  }
}

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
    context.strokeStyle = INK;
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
        <span className="muted"><PenLine size={14} /><Bi ar={"ارسم توقيعك بالماوس أو بالإصبع"} en={"Draw your signature"} /></span>
        <button type="button" className="button button-quiet" onClick={clear}><Eraser size={15} />مسح</button>
        <button type="button" className="button button-primary" disabled={empty || busy} onClick={() => void save()}><Check size={15} />حفظ التوقيع</button>
      </div>
    </div>
  );
}

/** Three ways to sign: draw it, upload a picture of it, or type the name in a script font. */
export function SignatureMaker({ onSave, defaultName = '' }: { onSave: (image: string) => Promise<void>; defaultName?: string }) {
  const [mode, setMode] = useState<'draw' | 'upload' | 'type'>('draw');
  const [preview, setPreview] = useState<string | null>(null);
  const [name, setName] = useState(defaultName);
  const [font, setFont] = useState(SIGNATURE_FONTS[0].id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (mode !== 'type' || !name.trim()) { if (mode === 'type') setPreview(null); return; }
    let live = true;
    void typedSignature(name.trim(), font).then((image) => { if (live) setPreview(image); });
    return () => { live = false; };
  }, [mode, name, font]);
  async function pick(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setError('');
    try { setPreview(await uploadedSignature(file)); } catch (problem) { setError(problem instanceof Error ? problem.message : 'تعذر قراءة الصورة.'); }
  }
  async function save() {
    if (!preview) return;
    setBusy(true);
    try { await onSave(preview); } finally { setBusy(false); }
  }
  return (
    <div className="signature-maker">
      <div className="segmented signature-modes">
        <button type="button" aria-pressed={mode === 'draw'} onClick={() => { setMode('draw'); setPreview(null); }}><PenLine size={14} /><Bi ar={"رسم"} en={"Draw"} /></button>
        <button type="button" aria-pressed={mode === 'upload'} onClick={() => { setMode('upload'); setPreview(null); }}><ImageUp size={14} /><Bi ar={"رفع صورة"} en={"Upload"} /></button>
        <button type="button" aria-pressed={mode === 'type'} onClick={() => setMode('type')}><Type size={14} /><Bi ar={"كتابة"} en={"Type"} /></button>
      </div>
      {mode === 'draw' && <SignaturePad onSave={onSave} />}
      {mode === 'upload' && <div className="signature-upload">
        <label className="button button-quiet"><ImageUp size={15} />اختر صورة التوقيع (PNG / JPG)<input type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(event) => void pick(event)} /></label>
        <small className="muted">وقّع على ورقة بيضاء وصوّرها؛ تُزال الخلفية البيضاء تلقائياً.</small>
      </div>}
      {mode === 'type' && <div className="signature-type">
        <label className="field"><span><Bi ar={"الاسم بالإنكليزي كما تريد أن يظهر"} en={"Name"} /></span><input value={name} dir="ltr" maxLength={40} onChange={(event) => setName(event.target.value)} placeholder="Aws F. Al-Shalal" /></label>
        <div className="signature-fonts">{SIGNATURE_FONTS.map((item) => <button type="button" key={item.id} className={font === item.id ? 'is-on' : ''} style={{ fontFamily: `"${item.id}", cursive` }} onClick={() => setFont(item.id)}>{name.trim() || 'Signature'}</button>)}</div>
      </div>}
      {error && <p className="form-error">{error}</p>}
      {mode !== 'draw' && preview && <div className="signature-preview">
        <img src={preview} alt="معاينة التوقيع" />
        <button type="button" className="button button-primary" disabled={busy} onClick={() => void save()}><Check size={15} />حفظ التوقيع</button>
      </div>}
    </div>
  );
}

/** The signed-in person's saved signature with the pad to replace it. */
export function MySignature() {
  const session = useSession();
  const signature = useLoad<{ image: string | null }>('/auth/signature', { image: null });
  return (
    <section className="panel">
      <div className="panel-head"><div><h3><Bi ar={"توقيعي الإلكتروني"} en={"My e-signature"} /></h3><p>ارسمه أو ارفع صورته أو اكتبه بخط توقيع مزخرف. يُستخدم في اعتماد المسيرات والطلبات، وكل اعتماد يحفظ نسخة من التوقيع وقت التوقيع.</p></div></div>
      {signature.data.image && <div className="signature-current"><img src={signature.data.image} alt="التوقيع الحالي" /><span className="muted">التوقيع المحفوظ حالياً</span></div>}
      <SignatureMaker defaultName={session.user.name && /[a-z]/i.test(session.user.name) ? session.user.name : ''} onSave={async (image) => {
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
