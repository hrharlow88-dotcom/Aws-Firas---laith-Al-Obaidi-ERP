import 'dotenv/config';
import { runMigrations } from './migrator';

void runMigrations()
  .then((applied) => {
    console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database schema is up to date.');
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error('Migration failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
