import { defineConfig } from 'drizzle-kit';

// Generates SQL only. Migrations are applied by wrangler against the `DB` binding.
export default defineConfig({
  dialect: 'sqlite',
  schema: './worker/db/schema.ts',
  out: './migrations',
});
