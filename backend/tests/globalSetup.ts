import './env';
import { Sequelize } from 'sequelize';
import { connectionOptions } from '../src/db/connection';
import { runMigrations } from '../src/db/migrator';

export default async function setup(): Promise<void> {
  if (!/test/.test(process.env.DB_NAME || '')) {
    throw new Error('Refusing to reset a database whose name does not contain "test".');
  }
  const sequelize = new Sequelize(connectionOptions({ pool: { max: 1, min: 0 } }));
  await sequelize.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await sequelize.close();
  await runMigrations();
}
