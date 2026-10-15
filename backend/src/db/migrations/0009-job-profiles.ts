import type { MigrationContext } from '../migrator';

/**
 * Job descriptions and KPIs imported from the L-O performance portal
 * (JD · KPI · evaluation system). One profile per job title, keyed by the
 * shared job code, so both systems talk about the same position.
 */
export async function up({ sequelize }: MigrationContext): Promise<void> {
  const statements = [
    `CREATE TABLE IF NOT EXISTS job_profiles (
      job_title_id uuid PRIMARY KEY REFERENCES job_titles(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      title_en varchar(150),
      title_ar varchar(150),
      purpose_ar text,
      purpose_en text,
      duties jsonb NOT NULL DEFAULT '[]'::jsonb,
      kpis jsonb NOT NULL DEFAULT '[]'::jsonb,
      qualifications jsonb NOT NULL DEFAULT '{}'::jsonb,
      technical jsonb NOT NULL DEFAULT '[]'::jsonb,
      behavioural jsonb NOT NULL DEFAULT '[]'::jsonb,
      overview jsonb NOT NULL DEFAULT '{}'::jsonb,
      kpi_weight_total numeric(6,2) NOT NULL DEFAULT 0,
      source varchar(40) NOT NULL DEFAULT 'lo-hr-portal',
      source_exported_at varchar(40),
      imported_at timestamptz NOT NULL DEFAULT now(),
      imported_by uuid REFERENCES users(id) ON UPDATE CASCADE ON DELETE SET NULL
    )`,
  ];
  for (const statement of statements) {
    await sequelize.query(statement);
  }
}
