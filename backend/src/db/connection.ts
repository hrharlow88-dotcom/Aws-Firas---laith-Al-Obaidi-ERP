import { Options } from 'sequelize';

export function connectionOptions(overrides: Partial<Options> = {}): Options {
  return {
    dialect: 'postgres',
    database: process.env.DB_NAME || 'erp_system',
    username: process.env.DB_USER || 'erp_app',
    password: process.env.DB_PASSWORD || '',
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 5432),
    logging: false,
    dialectOptions: process.env.DB_SSL === 'true'
      ? { ssl: { require: true, rejectUnauthorized: true } }
      : undefined,
    pool: { max: 10, min: 0, acquire: 30000, idle: 10000 },
    ...overrides,
  };
}
