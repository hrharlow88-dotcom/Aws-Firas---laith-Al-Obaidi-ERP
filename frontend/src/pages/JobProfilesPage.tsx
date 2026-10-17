import { ChangeEvent, useMemo, useState } from 'react';
import { ExternalLink, FileUp, Gauge, Search, Target } from 'lucide-react';
import { Dialog, Empty, Loading, Tone, Warning } from '../components/ui';
import { navigate } from '../lib/router';
import { useCrumb } from '../lib/breadcrumbs';
import { useLoad, useSession } from '../lib/session';
import { formatDate } from '../lib/format';

/**
 * Job descriptions and KPIs imported from the L-O performance portal.
 * The ERP shows them per job title and per employee; evaluations themselves
 * stay in the portal, opened from here with the job code / employee number.
 */

type Pair = [string, string];

interface Kpi { en: string; ar: string; t_en: string; t_ar: string; m_en: string; m_ar: string; f_en: string; f_ar: string; w: number }

interface ProfileRow {
  jobTitleId: string;
  code: string;
  name: string;
  grade: string | null;
  departmentName: string | null;
  titleEn: string | null;
  kpiCount: number;
  kpiWeight: number;
  importedAt: string;
  employeeCount: number;
}

interface ProfileList {
  items: ProfileRow[];
  portalUrl: string;
  lastImportAt: string | null;
  sourceExportedAt: string | null;
}

export interface JobProfile {
  jobTitleId: string;
  code: string;
  name: string;
  grade: string | null;
  departmentName: string | null;
  titleEn: string | null;
  titleAr: string | null;
  purposeAr: string | null;
  purposeEn: string | null;
  duties: Pair[];
  kpis: Kpi[];
  qualifications: { education?: Pair; experience?: Pair; languages?: Pair };
  technical: Pair[];
  behavioural: Pair[];
  overview: Record<string, string[]>;
  kpiWeight: number;
  importedAt: string;
  portalUrl: string;
}

interface ImportSummary {
  dryRun: boolean;
  jobs: number;
  invalid: number;
  newTitles: string[];
  newProfiles: number;
  updatedProfiles: number;
  unmatchedDepartments: string[];
  weightWarnings: string[];
}

/** Portal overview values are often "English / عربي"; show the Arabic side. */
function arabicPart(value: string): string {
  const parts = value.split(' / ');
  return parts.length > 1 && /[\u0600-\u06FF]/.test(parts[parts.length - 1]) ? parts[parts.length - 1] : value;
}

const OVERVIEW_LABELS: Record<string, string> = {
  'Reports To': 'المرجع المباشر',
  Grade: 'الدرجة',
  Branches: 'مواقع العمل',
  Headcount: 'العدد المعتمد',
  'Employment Type': 'نوع التوظيف',
};

export function JobProfilesPage({ jobTitleId }: { jobTitleId?: string }) {
  if (jobTitleId) {
    return (
      <section className="screen">
        <JobProfileView jobTitleId={jobTitleId} crumb />
      </section>
    );
  }
  return <JobProfileList />;
}

function JobProfileList() {
  const session = useSession();
  const canImport = session.can('org.manage');
  const list = useLoad<ProfileList>('/org/job-profiles', { items: [], portalUrl: '', lastImportAt: null, sourceExportedAt: null });
  const [search, setSearch] = useState('');
  const [importing, setImporting] = useState(false);
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return list.data.items;
    return list.data.items.filter((row) => [row.code, row.name, row.titleEn, row.departmentName]
      .some((value) => (value || '').toLowerCase().includes(q)));
  }, [list.data.items, search]);
  const totalKpis = list.data.items.reduce((sum, row) => sum + row.kpiCount, 0);

  return (
    <section className="screen">
      <div className="screen-heading">
        <div>
          <h2>الأوصاف الوظيفية ومؤشرات الأداء</h2>
          <p>
            مرتبطة ببوابة تقييم الأداء عبر رمز الوظيفة.
            {list.data.lastImportAt ? ` آخر تحديث ${formatDate(list.data.lastImportAt)}` : ' لم يُستورد ملف بعد.'}
          </p>
        </div>
        <div className="heading-actions">
          {list.data.portalUrl && <a className="button button-quiet" href={`${list.data.portalUrl}/#/eval`} target="_blank" rel="noopener noreferrer"><ExternalLink size={16} />بوابة التقييم</a>}
          {canImport && <button className="button button-primary" onClick={() => setImporting(true)}><FileUp size={16} />استيراد ملف الأوصاف</button>}
        </div>
      </div>

      <div className="stat-row">
        <div className="stat"><span className="stat-label">أوصاف وظيفية</span><strong>{list.data.items.length}</strong></div>
        <div className="stat"><span className="stat-label">مؤشرات أداء</span><strong>{totalKpis}</strong></div>
        <div className="stat"><span className="stat-label">موظفون مرتبطون</span><strong>{list.data.items.reduce((sum, row) => sum + row.employeeCount, 0)}</strong></div>
      </div>

      <section className="panel">
        <div className="filter-bar">
          <label className="search-field"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="ابحث بالرمز أو المسمى أو القسم…" aria-label="بحث في الأوصاف" /></label>
          <span className="result-count">{rows.length} وصف</span>
        </div>
        {list.loading ? <Loading /> : rows.length ? <div className="table-scroll"><table>
          <thead><tr><th>المسمى</th><th>الرمز</th><th>القسم</th><th>الدرجة</th><th>المؤشرات</th><th>الموظفون</th></tr></thead>
          <tbody>{rows.map((row) => <tr key={row.jobTitleId} className="row-link" onClick={() => navigate('kpi', row.jobTitleId)}>
            <td><strong>{row.name}</strong>{row.titleEn && <small className="table-sub" dir="ltr">{row.titleEn}</small>}</td>
            <td><span className="code-tag">{row.code}</span></td>
            <td>{row.departmentName || '—'}</td>
            <td>{row.grade || '—'}</td>
            <td>{row.kpiCount} {Math.abs(row.kpiWeight - 100) > 0.01 && row.kpiCount ? <Tone tone="warn">{row.kpiWeight}%</Tone> : null}</td>
            <td>{row.employeeCount}</td>
          </tr>)}</tbody>
        </table></div> : <Empty icon={<Target size={22} />} title={list.data.items.length ? 'لا نتائج' : 'لا توجد أوصاف بعد'}
          text={list.data.items.length ? 'جرّب كلمة بحث أخرى.' : 'صدّر ملف الأوصاف والمؤشرات من بوابة الأداء (الإعدادات ← تصدير للـ ERP) ثم استورده هنا.'} />}
      </section>

      <ImportDialog open={importing} onClose={() => setImporting(false)} onDone={() => { setImporting(false); list.reload(); }} />
    </section>
  );
}

function ImportDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const session = useSession();
  const [file, setFile] = useState<unknown>(null);
  const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState<ImportSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const reset = () => { setFile(null); setFileName(''); setPreview(null); setError(''); };

  const pick = async (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = event.target.files?.[0];
    event.target.value = '';
    reset();
    if (!chosen) return;
    setFileName(chosen.name);
    try {
      const parsed = JSON.parse(await chosen.text());
      setFile(parsed);
      setBusy(true);
      const result = await session.call<{ data: ImportSummary }>('/org/job-profiles/import', { body: { file: parsed, dryRun: true } });
      setPreview(result.data);
    } catch (problem) {
      setError(problem instanceof SyntaxError ? 'الملف ليس JSON صالحاً.' : problem instanceof Error ? problem.message : 'تعذرت قراءة الملف.');
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    setBusy(true);
    try {
      const result = await session.call<{ data: ImportSummary }>('/org/job-profiles/import', { body: { file } });
      session.notify(`تم استيراد ${result.data.jobs} وصفاً وظيفياً مع مؤشراتها.`);
      reset();
      onDone();
    } catch (problem) {
      session.fail(problem, 'تعذر الاستيراد.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} title="استيراد الأوصاف الوظيفية ومؤشرات الأداء" subtitle="ملف JSON مُصدَّر من بوابة الأداء (lo-hr.jd-kpi)" onClose={() => { reset(); onClose(); }}>
      <div className="form-stack">
        <label className="button button-quiet file-pick"><FileUp size={16} />{fileName || 'اختيار الملف'}<input type="file" accept="application/json,.json" hidden onChange={(event) => void pick(event)} /></label>
        {busy && <Loading label="جارٍ فحص الملف…" />}
        {error && <Warning title="لا يمكن استيراد الملف">{error}</Warning>}
        {preview && <>
          <div className="chips">
            <span className="chip">أوصاف في الملف <b>{preview.jobs}</b></span>
            <span className="chip">مسميات جديدة <b>{preview.newTitles.length}</b></span>
            <span className="chip">أوصاف جديدة <b>{preview.newProfiles}</b></span>
            <span className="chip">تحديث أوصاف موجودة <b>{preview.updatedProfiles}</b></span>
            {preview.invalid > 0 && <span className="chip">مرفوضة (رمز غير صالح) <b>{preview.invalid}</b></span>}
          </div>
          {preview.unmatchedDepartments.length > 0 && <Warning title="أقسام غير موجودة في الـ ERP">
            ستُنشأ مسمياتها بدون قسم، ويمكن ربطها لاحقاً من الهيكل التنظيمي: {preview.unmatchedDepartments.join('، ')}
          </Warning>}
          {preview.weightWarnings.length > 0 && <Warning title="أوزان مؤشرات لا تساوي 100%">{preview.weightWarnings.join('، ')}</Warning>}
          <p className="muted-note">المسميات الموجودة تحتفظ بأسمائها في الـ ERP، ويُحدَّث وصفها ومؤشراتها فقط.</p>
          <div className="dialog-actions">
            <button className="button button-primary" disabled={busy} onClick={() => void confirm()}>تأكيد الاستيراد</button>
            <button className="button button-quiet" onClick={() => { reset(); onClose(); }}>إلغاء</button>
          </div>
        </>}
      </div>
    </Dialog>
  );
}

/** Full job description + KPIs for one job title (also used inside the employee file). */
export function JobProfileView({ jobTitleId, employeeNo, crumb = false }: { jobTitleId: string; employeeNo?: string; crumb?: boolean }) {
  const profile = useLoad<JobProfile | null>(`/org/job-titles/${jobTitleId}/profile`, null);
  useCrumb(crumb && profile.data ? `${profile.data.code} · ${profile.data.name}` : null);
  if (profile.loading) return <section className="panel"><Loading /></section>;
  const p = profile.data;
  if (!p) {
    return <section className="panel"><Empty icon={<Target size={22} />} title="لا يوجد وصف ومؤشرات لهذا المسمى" text="استورد ملف الأوصاف من بوابة الأداء، أو تأكد أن رمز المسمى في الـ ERP يطابق رمز الوظيفة في البوابة." /></section>;
  }
  const portal = p.portalUrl;
  const pair = (value?: Pair) => value && (value[1] || value[0]);
  return (
    <div className="profile-stack">
      <section className="panel">
        <div className="panel-head">
          <div><h3>{p.name} <span className="code-tag">{p.code}</span></h3><p>{p.departmentName || '—'}{p.titleEn ? ` · ${p.titleEn}` : ''}</p></div>
          <div className="heading-actions">
            <a className="button button-quiet" href={`${portal}/#/jd/${encodeURIComponent(p.code)}`} target="_blank" rel="noopener noreferrer"><ExternalLink size={15} />في البوابة</a>
            {employeeNo && <a className="button button-primary" href={`${portal}/#/eval?emp=${encodeURIComponent(employeeNo)}`} target="_blank" rel="noopener noreferrer"><Gauge size={15} />تقييم الأداء</a>}
          </div>
        </div>
        <div className="jp-body">
          {pair([p.purposeEn || '', p.purposeAr || '']) && <p className="jp-purpose">{p.purposeAr || p.purposeEn}</p>}
          <dl className="jp-overview">
            {Object.entries(p.overview).map(([key, value]) => <div key={key}><dt>{OVERVIEW_LABELS[key] ?? key}</dt><dd>{arabicPart(value[1] || value[0])}</dd></div>)}
          </dl>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head"><div><h3>مؤشرات الأداء الرئيسية</h3><p>مجموع الأوزان {p.kpiWeight}%</p></div></div>
        <div className="table-scroll"><table>
          <thead><tr><th>#</th><th>المؤشر</th><th>الهدف</th><th>طريقة القياس</th><th>الدورية</th><th>الوزن</th></tr></thead>
          <tbody>{p.kpis.map((k, index) => <tr key={index}>
            <td>{index + 1}</td>
            <td><strong>{k.ar || k.en}</strong>{k.ar && k.en && <small className="table-sub" dir="ltr">{k.en}</small>}</td>
            <td><span dir="auto" className="jp-target">{k.t_ar || k.t_en || '—'}</span></td>
            <td>{k.m_ar || k.m_en || '—'}</td>
            <td>{k.f_ar || k.f_en || '—'}</td>
            <td><strong>{k.w}%</strong></td>
          </tr>)}</tbody>
        </table></div>
      </section>

      <section className="panel">
        <div className="panel-head"><div><h3>المهام والمسؤوليات</h3></div></div>
        <ol className="jp-list">{p.duties.map((d, index) => <li key={index}>{d[1] || d[0]}</li>)}</ol>
      </section>

      <div className="jp-grid">
        <section className="panel">
          <div className="panel-head"><div><h3>المؤهلات</h3></div></div>
          <dl className="jp-overview">
            <div><dt>التعليم</dt><dd>{pair(p.qualifications.education) || '—'}</dd></div>
            <div><dt>الخبرة</dt><dd>{pair(p.qualifications.experience) || '—'}</dd></div>
            <div><dt>اللغات</dt><dd>{pair(p.qualifications.languages) || '—'}</dd></div>
          </dl>
        </section>
        <section className="panel">
          <div className="panel-head"><div><h3>الكفاءات</h3></div></div>
          <div className="chips jp-chips">{p.technical.map((c, index) => <span className="chip" key={`t${index}`}>{c[1] || c[0]}</span>)}</div>
          <div className="chips jp-chips">{p.behavioural.map((c, index) => <span className="chip jp-beh" key={`b${index}`}>{c[1] || c[0]}</span>)}</div>
        </section>
      </div>
      <p className="muted-note">مصدر الوصف: بوابة الأداء · آخر استيراد {formatDate(p.importedAt)}</p>
    </div>
  );
}
