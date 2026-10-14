import type { MigrationContext } from '../migrator';

/** Word templates for employment contracts, filled from the employee file. */
export async function up({ sequelize }: MigrationContext): Promise<void> {
  const statements = [
    `CREATE TABLE IF NOT EXISTS contract_templates (
      id uuid PRIMARY KEY,
      name varchar(120) NOT NULL,
      contract_type varchar(20) CHECK (contract_type IN ('permanent','fixed_term','probation','daily','part_time','contractor')),
      description varchar(500),
      storage_key varchar(300) NOT NULL,
      original_name varchar(255) NOT NULL,
      size_bytes integer NOT NULL,
      sha256 char(64) NOT NULL,
      fields jsonb NOT NULL DEFAULT '[]'::jsonb,
      is_active boolean NOT NULL DEFAULT true,
      uploaded_by uuid NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`,
    'ALTER TABLE employee_contracts ADD COLUMN IF NOT EXISTS template_id uuid REFERENCES contract_templates(id) ON UPDATE CASCADE ON DELETE SET NULL',
  ];
  for (const statement of statements) {
    await sequelize.query(statement);
  }
}
