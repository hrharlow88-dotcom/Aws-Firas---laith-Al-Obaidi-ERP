import { ChangeEvent, FormEvent, useEffect, useState } from 'react';
import { Building2, Image, Pencil, Plus, Upload } from 'lucide-react';
import { Bi, refreshBrands, useBrands } from '../components/Brand';
import { Dialog, Empty, Loading, Stat } from '../components/ui';
import { apiBlob } from '../lib/api';
import { formatNumber } from '../lib/format';
import { useLoad, useSession } from '../lib/session';

interface Company {
  id: string; code: string; nameAr: string; nameEn: string | null; legalName: string | null; registrationNo: string | null; taxNo: string | null;
  address: string | null; phone: string | null; email: string | null; brandIds: string[]; sortOrder: number; isActive: boolean;
  hasLogo: boolean; logoVersion: string; branches: number; employees: number;
}
interface Branch { id: string; name: string; city: string; companyId: string | null; employeeCount?: number }

function Logo({ company }: { company: Company }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!company.hasLogo) { setUrl(null); return; }
    setUrl(`/api/public/companies/${company.id}/logo?v=${company.logoVersion}`);
  }, [company.id, company.hasLogo, company.logoVersion]);
  return <div className="company-logo">{url ? <img src={url} alt={company.nameAr} /> : <Building2 size={30} />}</div>;
}

/** The companies of the group, each with its branches, brands and logo. */
export function CompaniesPage() {
  const session = useSession();
  const owner = session.user.role === 'super_admin';
  const companies = useLoad<Company[]>('/companies', []);
  const branches = useLoad<Branch[]>('/branches', []);
  const brands = useBrands();
  const [editing, setEditing] = useState<Partial<Company> | null>(null);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body = {
      code: form.get('code'), nameAr: form.get('nameAr'), nameEn: form.get('nameEn') || null, legalName: form.get('legalName') || null,
      registrationNo: form.get('registrationNo') || null, taxNo: form.get('taxNo') || null, address: form.get('address') || null,
      phone: form.get('phone') || null, email: form.get('email') || null, brandIds: form.getAll('brandIds'),
      sortOrder: Number(form.get('sortOrder') || 0), isActive: form.get('isActive') === 'on',
    };
    try {
      if (editing?.id) await session.call(`/companies/${editing.id}`, { method: 'PUT', body });
      else await session.call('/companies', { method: 'POST', body });
      session.notify('حُفظت الشركة.');
      setEditing(null);
      companies.reload();
      refreshBrands();
    } catch (error) { session.fail(error, 'تعذر الحفظ.'); }
  }
  async function upload(company: Company, event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const form = new FormData();
    form.set('file', file);
    try { await session.call(`/companies/${company.id}/logo`, { form }); companies.reload(); refreshBrands(); session.notify('رُفع الشعار.'); }
    catch (error) { session.fail(error, 'تعذر رفع الشعار.'); }
  }
  async function moveBranch(branch: Branch, companyId: string) {
    try { await session.call(`/branches/${branch.id}`, { method: 'PUT', body: { companyId: companyId || null } }); branches.reload(); companies.reload(); }
    catch (error) { session.fail(error, 'تعذر الربط.'); }
  }
  void apiBlob;

  return (
    <section className="screen">
      <div className="screen-heading"><div><h2><Bi ar="شركات المجموعة" en="Group companies" /></h2><p>الشركات التابعة لمجموعة الليث العبيدي، لكل شركة فروعها وعلاماتها التجارية وشعارها، وتظهر شعاراتها في شاشة الدخول.</p></div>
        {owner && <button className="button button-primary" onClick={() => setEditing({ isActive: true, brandIds: [] })}><Plus size={16} />شركة جديدة · New company</button>}</div>
      <div className="stat-row"><Stat label="الشركات · Companies" value={formatNumber(companies.data.length)} />
        <Stat label="الفروع المرتبطة" value={formatNumber(branches.data.filter((branch) => branch.companyId).length)} foot={`من ${branches.data.length}`} />
        <Stat label="العلامات · Brands" value={formatNumber(brands.length)} /></div>
      {companies.loading ? <Loading /> : !companies.data.length ? <section className="panel"><Empty icon={<Building2 size={22} />} title="لا توجد شركات" text="أضف شركات المجموعة واربط بها الفروع." /></section>
        : <div className="company-grid">{companies.data.map((company) => <article key={company.id} className={`company-card ${company.isActive ? '' : 'is-off'}`}>
          <Logo company={company} />
          <strong>{company.nameAr}</strong>{company.nameEn && <small dir="ltr">{company.nameEn}</small>}
          <span className="company-code" dir="ltr">{company.code}</span>
          <div className="company-brands">{company.brandIds.map((id) => <span key={id}>{brands.find((brand) => brand.id === id)?.name ?? id}</span>)}</div>
          <div className="company-stats"><span>{company.branches} فرع</span><span>{company.employees} موظف</span></div>
          {owner && <div className="row-actions">
            <button className="button button-quiet button-small" onClick={() => setEditing(company)}><Pencil size={13} />تعديل</button>
            <label className="button button-quiet button-small"><Upload size={13} />الشعار<input type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(event) => void upload(company, event)} /></label>
          </div>}
        </article>)}</div>}
      <section className="panel">
        <div className="panel-head"><div><h3>ربط الفروع بالشركات · Branches</h3><p>كل فرع يتبع شركة واحدة من شركات المجموعة.</p></div></div>
        <div className="table-scroll"><table className="dense"><thead><tr><th>الفرع</th><th>المدينة</th><th>الموظفون</th><th>الشركة</th></tr></thead>
          <tbody>{branches.data.map((branch) => <tr key={branch.id}><td><strong>{branch.name}</strong></td><td>{branch.city}</td><td>{branch.employeeCount ?? '—'}</td>
            <td>{owner ? <select value={branch.companyId ?? ''} onChange={(event) => void moveBranch(branch, event.target.value)}><option value="">— بلا شركة —</option>{companies.data.map((company) => <option key={company.id} value={company.id}>{company.nameAr}</option>)}</select>
              : companies.data.find((company) => company.id === branch.companyId)?.nameAr ?? '—'}</td></tr>)}</tbody></table></div>
      </section>
      <Dialog wide open={Boolean(editing)} title={editing?.id ? 'تعديل الشركة' : 'شركة جديدة'} onClose={() => setEditing(null)}>
        {editing && <form className="form-grid" onSubmit={(event) => void save(event)}>
          <label className="field"><span>الرمز *</span><input name="code" required maxLength={24} defaultValue={editing.code ?? ''} dir="ltr" /></label>
          <label className="field"><span>الترتيب</span><input name="sortOrder" type="number" defaultValue={editing.sortOrder ?? 0} /></label>
          <label className="field"><span>الاسم بالعربي *</span><input name="nameAr" required maxLength={160} defaultValue={editing.nameAr ?? ''} /></label>
          <label className="field"><span>Name (English)</span><input name="nameEn" maxLength={160} dir="ltr" defaultValue={editing.nameEn ?? ''} /></label>
          <label className="field"><span>الاسم القانوني</span><input name="legalName" maxLength={200} defaultValue={editing.legalName ?? ''} /></label>
          <label className="field"><span>رقم التسجيل</span><input name="registrationNo" maxLength={80} defaultValue={editing.registrationNo ?? ''} /></label>
          <label className="field"><span>الرقم الضريبي</span><input name="taxNo" maxLength={80} defaultValue={editing.taxNo ?? ''} /></label>
          <label className="field"><span>الهاتف</span><input name="phone" maxLength={40} defaultValue={editing.phone ?? ''} /></label>
          <label className="field"><span>البريد</span><input name="email" type="email" maxLength={254} defaultValue={editing.email ?? ''} /></label>
          <label className="field settings-wide"><span>العنوان</span><input name="address" maxLength={240} defaultValue={editing.address ?? ''} /></label>
          <fieldset className="settings-wide brand-picks"><legend>العلامات التجارية للشركة</legend>
            {brands.map((brand) => <label key={brand.id} className="settings-check"><input type="checkbox" name="brandIds" value={brand.id} defaultChecked={editing.brandIds?.includes(brand.id)} />{brand.logo && <img src={brand.logo} alt="" />}{brand.name}</label>)}
          </fieldset>
          <label className="settings-check"><input type="checkbox" name="isActive" defaultChecked={editing.isActive !== false} />فعّالة</label>
          <div className="dialog-actions settings-wide"><button className="button button-primary">حفظ</button></div>
        </form>}
      </Dialog>
      <p className="muted"><Image size={13} /> العلامات التجارية وشعاراتها تُدار من «لوحة المالك ← العلامات».</p>
    </section>
  );
}
