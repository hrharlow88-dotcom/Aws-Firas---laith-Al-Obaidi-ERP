import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { ArrowRight, CheckCircle2, Printer, XCircle } from 'lucide-react';
import { useEmployeePhoto } from '../components/EmployeePhoto';
import { Loading } from '../components/ui';
import { formatDate, formatDateTime } from '../lib/format';
import { useLoad } from '../lib/session';

interface CardData {
  id: string; employeeNo: string; fullName: string; nameEn: string | null; jobTitle: string; department: string;
  branchName: string; hireDate: string; bloodType: string | null; cardToken: string | null; cardIssuedAt: string | null;
  hasPhoto: boolean; employmentStatus: string;
}

function verifyUrl(token: string): string {
  return `${window.location.origin}/#/verify/${token}`;
}

/** Printable CR80 ID card (85.6 × 54 mm), front and back. */
export function EmployeeCardPage({ employeeId }: { employeeId: string }) {
  const card = useLoad<CardData | null>(`/employees/${employeeId}/card`, null);
  const photo = useEmployeePhoto(employeeId, Boolean(card.data?.hasPhoto));
  const [qr, setQr] = useState<string | null>(null);
  useEffect(() => {
    if (!card.data?.cardToken) return;
    void QRCode.toDataURL(verifyUrl(card.data.cardToken), { margin: 1, width: 240, errorCorrectionLevel: 'M', color: { dark: '#1d1b1f', light: '#ffffff' } })
      .then(setQr);
  }, [card.data?.cardToken]);
  const data = card.data;
  if (card.loading && !data) return <section className="screen"><Loading /></section>;
  if (!data) return null;
  if (!data.cardToken) return <section className="screen"><p>لم تصدر بطاقة لهذا الموظف بعد.</p></section>;
  return (
    <section className="screen">
      <div className="no-print screen-heading">
        <button className="back-link" onClick={() => window.history.back()}><ArrowRight size={15} />رجوع</button>
        <button className="button button-primary" onClick={() => window.print()}><Printer size={16} />طباعة</button>
      </div>
      <p className="no-print hint">مقاس بطاقة قياسي 85.6 × 54 ملم. اطبع بمقياس 100% (بدون ملاءمة للصفحة).</p>
      <div className="id-cards print-area">
        <div className="id-card id-front">
          <div className="id-band"><img src="/brand/shield-256.png" alt="" /><div><strong>شركة الليث العبيدي</strong><span>AL-LAITH AL-OBAIDI</span></div></div>
          <div className="id-body">
            {photo ? <img className="id-photo" src={photo} alt="" /> : <div className="id-photo id-photo-empty">{data.fullName.slice(0, 1)}</div>}
            <div className="id-info">
              <strong>{data.fullName}</strong>
              {data.nameEn && <span className="id-en" dir="ltr">{data.nameEn}</span>}
              <span>{data.jobTitle}</span>
              <span className="id-muted">{data.department} · {data.branchName}</span>
              <span className="id-no" dir="ltr">ID {data.employeeNo}</span>
            </div>
          </div>
          <div className="id-stripe" />
        </div>
        <div className="id-card id-back">
          <div className="id-back-body">
            {qr && <img className="id-qr" src={qr} alt="رمز التحقق" />}
            <div className="id-back-info">
              <p><small>تاريخ التعيين</small>{formatDate(data.hireDate)}</p>
              {data.bloodType && <p><small>فصيلة الدم</small><span dir="ltr">{data.bloodType}</span></p>}
              <p><small>صدرت في</small>{formatDate(data.cardIssuedAt)}</p>
              <p className="id-note">هذه البطاقة ملك الشركة. امسح الرمز للتحقق من صلاحيتها. في حال العثور عليها يرجى إعادتها إلى قسم الموارد البشرية.</p>
            </div>
          </div>
          <div className="id-stripe" />
        </div>
      </div>
    </section>
  );
}

/** Public page behind the QR code; works without logging in. */
export function VerifyCardPage({ token }: { token: string }) {
  const [state, setState] = useState<{ loading: boolean; data?: { fullName: string; employeeNo: string; jobTitle: string; branchName: string; valid: boolean; company: string; cardIssuedAt: string }; error?: string }>({ loading: true });
  useEffect(() => {
    fetch(`/api/public/cards/${encodeURIComponent(token)}`)
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        setState(response.ok ? { loading: false, data: body.data } : { loading: false, error: body.message || 'البطاقة غير صالحة.' });
      })
      .catch(() => setState({ loading: false, error: 'تعذر الاتصال بالخادم.' }));
  }, [token]);
  const valid = state.data?.valid;
  return (
    <main className="verify-page">
      <div className="verify-card">
        <img src="/brand/shield-256.png" alt="" className="verify-shield" />
        <h1>التحقق من بطاقة موظف</h1>
        {state.loading ? <Loading /> : state.data ? <>
          <div className={`verify-status ${valid ? 'ok' : 'bad'}`}>{valid ? <CheckCircle2 size={22} /> : <XCircle size={22} />}{valid ? 'بطاقة صالحة' : 'الموظف لم يعد على رأس العمل'}</div>
          <dl>
            <div><dt>الاسم</dt><dd>{state.data.fullName}</dd></div>
            <div><dt>الرقم الوظيفي</dt><dd dir="ltr">{state.data.employeeNo}</dd></div>
            <div><dt>المسمى</dt><dd>{state.data.jobTitle}</dd></div>
            <div><dt>الفرع</dt><dd>{state.data.branchName}</dd></div>
            <div><dt>صدرت في</dt><dd>{formatDateTime(state.data.cardIssuedAt)}</dd></div>
          </dl>
          <p className="verify-company">{state.data.company}</p>
        </> : <div className="verify-status bad"><XCircle size={22} />{state.error}</div>}
      </div>
    </main>
  );
}
