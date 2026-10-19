import { defineConfig } from 'drizzle-kit';

// `drizzle-kit generate` diffs src/schema.ts against drizzle/meta and writes SQL.
// RLS policies, grants and roles live in hand-written (custom) migrations beside them.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './drizzle',
});
