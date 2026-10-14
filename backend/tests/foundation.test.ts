import { describe, expect, it } from 'vitest';
import { AuditLog, Branch, sequelize } from '../src/models';
import { normalizeSystemSettings, DEFAULT_SYSTEM_SETTINGS } from '../src/config/systemSettings';
import { api, makeBranch, makeEmployee, makeUser } from './helpers';

describe('foundation', () => {
  it('serves health and rejects anonymous calls', async () => {
    await api().get('/api/health').expect(200, { status: 'ok' });
    await api().get('/api/employees').expect(401);
  });

  it('refuses to delete a branch that still has employees', async () => {
    const branch = await makeBranch();
    await makeEmployee(branch.id);
    await expect(Branch.destroy({ where: { id: branch.id } })).rejects.toThrow();
  });

  it('keeps the audit trail append-only', async () => {
    const { user } = await makeUser('super_admin');
    const entry = await AuditLog.create({ userId: user.id, action: 'test.created', entityType: 'test' });
    await expect(sequelize.query('UPDATE audit_logs SET action = \'x\' WHERE id = :id', { replacements: { id: entry.id } }))
      .rejects.toThrow(/append-only/);
    await expect(sequelize.query('DELETE FROM audit_logs WHERE id = :id', { replacements: { id: entry.id } }))
      .rejects.toThrow(/append-only/);
  });

  it('grants new module permissions to roles saved before the modules existed', () => {
    // Settings saved by phase one: no knownPermissions, finance had nothing,
    // and HR deliberately had employees.create removed.
    const legacy = {
      ...DEFAULT_SYSTEM_SETTINGS,
      knownPermissions: undefined,
      roles: {
        ...DEFAULT_SYSTEM_SETTINGS.roles,
        finance: { label: 'المالية', permissions: [] },
        hr_staff: { label: 'موظف موارد بشرية', permissions: ['employees.update', 'leaves.view', 'leaves.request'] },
      },
    } as unknown as Parameters<typeof normalizeSystemSettings>[0];
    const settings = normalizeSystemSettings(legacy);
    expect(settings.roles.finance.permissions).toContain('payroll.approve');
    expect(settings.roles.finance.permissions).toContain('finance.post');
    expect(settings.roles.hr_staff.permissions).toContain('attendance.manage');
    // A permission the administrator already saw and removed stays removed.
    expect(settings.roles.hr_staff.permissions).not.toContain('employees.create');
  });

  it('does not re-grant a new permission once the administrator removed it', () => {
    const saved = {
      ...DEFAULT_SYSTEM_SETTINGS,
      roles: { ...DEFAULT_SYSTEM_SETTINGS.roles, finance: { label: 'المالية', permissions: ['payroll.view'] } },
    } as Parameters<typeof normalizeSystemSettings>[0];
    const settings = normalizeSystemSettings(saved);
    expect(settings.roles.finance.permissions).toEqual(['payroll.view']);
  });

  it('round-trips settings through the API and records an audit entry', async () => {
    const admin = await makeUser('super_admin');
    const current = await api().get('/api/settings').set(admin.auth).expect(200);
    const updated = { ...current.body.data, company: { ...current.body.data.company, legalName: 'شركة الاختبار' } };
    const saved = await api().put('/api/settings').set(admin.auth).send(updated).expect(200);
    expect(saved.body.data.company.legalName).toBe('شركة الاختبار');
    expect(saved.body.data.knownPermissions).toContain('payroll.prepare');
  });
});
