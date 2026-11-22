import { defineConfig } from 'drizzle-kit';

// Drizzle is the only path for schema changes: edit src/db/schema.ts, then `npm run db:generate`.
// Never hand-edit drizzle/*.sql or drizzle/meta/*.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
});
