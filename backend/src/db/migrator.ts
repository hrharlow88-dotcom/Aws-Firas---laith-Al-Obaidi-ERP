import { QueryInterface, Sequelize } from 'sequelize';
import { SequelizeStorage, Umzug } from 'umzug';
import { connectionOptions } from './connection';
import * as m0001 from './migrations/0001-baseline';
import * as m0002 from './migrations/0002-integrity-and-audit';
import * as m0003 from './migrations/0003-org-and-employee-file';
import * as m0004 from './migrations/0004-attendance';
import * as m0005 from './migrations/0005-payroll-and-finance';
import * as m0006 from './migrations/0006-payroll-practice';
import * as m0007 from './migrations/0007-contract-templates';
import * as m0008 from './migrations/0008-access-and-roles';

export interface MigrationContext {
  queryInterface: QueryInterface;
  sequelize: Sequelize;
}

export interface MigrationModule {
  up: (context: MigrationContext) => Promise<void>;
}

/**
 * Migrations are registered explicitly (not globbed) so the compiled build and
 * ts-node runs see exactly the same ordered list.
 */
const MIGRATIONS: Array<[string, MigrationModule]> = [
  ['0001-baseline', m0001],
  ['0002-integrity-and-audit', m0002],
  ['0003-org-and-employee-file', m0003],
  ['0004-attendance', m0004],
  ['0005-payroll-and-finance', m0005],
  ['0006-payroll-practice', m0006],
  ['0007-contract-templates', m0007],
  ['0008-access-and-roles', m0008],
];

export function createMigrator(sequelize: Sequelize) {
  return new Umzug<MigrationContext>({
    migrations: MIGRATIONS.map(([name, module]) => ({
      name,
      up: ({ context }) => module.up(context),
    })),
    context: { queryInterface: sequelize.getQueryInterface(), sequelize },
    storage: new SequelizeStorage({ sequelize, tableName: 'schema_migrations' }),
    logger: undefined,
  });
}

/**
 * Applies pending migrations on a dedicated single-connection instance. The
 * session-level advisory lock is only reliable when lock, migrations and
 * unlock share one connection, which a pool of size one guarantees. It keeps
 * two API containers that boot together from applying a migration twice.
 */
export async function runMigrations(): Promise<string[]> {
  const sequelize = new Sequelize(connectionOptions({ pool: { max: 1, min: 0, acquire: 60000, idle: 10000 } }));
  try {
    await sequelize.query('SELECT pg_advisory_lock(727274)');
    try {
      const applied = await createMigrator(sequelize).up();
      return applied.map((item) => item.name);
    } finally {
      await sequelize.query('SELECT pg_advisory_unlock(727274)');
    }
  } finally {
    await sequelize.close();
  }
}
