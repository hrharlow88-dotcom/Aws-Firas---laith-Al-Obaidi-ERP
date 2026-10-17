import { ReactNode, useRef } from 'react';
import { FileText, Printer } from 'lucide-react';
import { useSession } from '../lib/session';
import { DEVELOPER, SYSTEM_NAME, Bi } from './Brand';

async function asDataUrl(src: string): Promise<string> {
  try {
    const blob = await (await fetch(src)).blob();
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => resolve(src);
      reader.readAsDataURL(blob);
    });
  } catch {
    return src;
  }
}

/** Saves the document as a Word file (Word opens the HTML with its styles and the company mark). */
export async function exportWord(element: HTMLElement, fileName: string): Promise<void> {
  const clone = element.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('.no-print, .no-export, button').forEach((node) => node.remove());
  for (const image of Array.from(clone.querySelectorAll('img'))) {
    image.setAttribute('src', await asDataUrl(image.getAttribute('src') || ''));
    if (!image.getAttribute('width')) image.setAttribute('width', String(Math.min(image.clientWidth || 64, 140)));
  }
  const html = `<!doctype html><html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"><title>${fileName}</title>
<style>body{font-family:Tahoma,Arial,sans-serif;direction:rtl;font-size:12pt;line-height:1.6}table{border-collapse:collapse;width:100%}td,th{border:1px solid #bbb;padding:4px 6px;text-align:right}
.doc-head{border-bottom:2px solid #E15532;margin-bottom:12px}.doc-foot{border-top:1px solid #ccc;margin-top:18px;font-size:9pt;color:#555}.doc-meta{font-size:9pt;color:#555}</style></head>
<body dir="rtl">${clone.outerHTML}</body></html>`;
  const blob = new Blob(['﻿', html], { type: 'application/msword' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${fileName}.doc`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 20000);
}

/**
 * Every document the system issues: the company mark and name at the top,
 * who prepared it and when, the reference, and the system and developer
 * credit at the foot. Print / save as PDF, or save as Word.
 */
export function DocumentFrame({ title, titleEn, reference, children, fileName, preparedBy }: {
  title: string;
  titleEn?: string;
  reference?: string | null;
  children: ReactNode;
  fileName?: string;
  preparedBy?: string;
}) {
  const session = useSession();
  const ref = useRef<HTMLDivElement>(null);
  const issued = new Intl.DateTimeFormat('ar-IQ-u-nu-latn', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Baghdad' }).format(new Date());
  return (
    <div className="doc-wrap">
      <div className="doc-toolbar no-print">
        <button className="button button-quiet" onClick={() => window.print()}><Printer size={15} />طباعة / PDF</button>
        <button className="button button-quiet" onClick={() => ref.current && void exportWord(ref.current, fileName ?? title)}><FileText size={15} />Word</button>
      </div>
      <div className="doc-sheet" ref={ref}>
        <header className="doc-head">
          <img src="/brand/shield-256.png" alt="" width={54} />
          <div>
            <strong>{session.settings.company.displayName || 'مجموعة الليث العبيدي للسيارات'}</strong>
            <span>{SYSTEM_NAME.ar}</span>
            <span dir="ltr">{SYSTEM_NAME.en}</span>
          </div>
          <img src="/brand/wordmark.png" alt="" width={130} className="doc-wordmark" />
        </header>
        <div className="doc-title">
          <h2>{title}</h2>
          {titleEn && <h3 dir="ltr">{titleEn}</h3>}
          <p className="doc-meta">
            {reference && <span><Bi ar={"المرجع"} en={"Ref:"} /> <b dir="ltr">{reference}</b></span>}
            <span><Bi ar={"أعدّه"} en={"Prepared by:"} /> <b>{preparedBy ?? session.user.name}</b></span>
            <span><Bi ar={"تاريخ الإصدار"} en={"Issued:"} /> <b>{issued}</b></span>
          </p>
        </div>
        <div className="doc-body">{children}</div>
        <footer className="doc-foot">
          <span>صادر من {SYSTEM_NAME.ar} · Issued by the {SYSTEM_NAME.en}</span>
          <span>{DEVELOPER.ar}</span>
        </footer>
      </div>
    </div>
  );
}
