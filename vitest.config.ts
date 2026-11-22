import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, 'drizzle')),
          ADMIN_API_TOKEN: 'test-admin-token',
          PUBLIC_BASE_URL: 'https://openmail.test',
          // Lane credentials for tenants created with secretPrefix SES_TEST (fake; SES is mocked).
          SES_TEST_TX_ACCESS_KEY_ID: 'AKIDTX',
          SES_TEST_TX_SECRET_ACCESS_KEY: 'test-secret',
          SES_TEST_BULK_ACCESS_KEY_ID: 'AKIDBULK',
          SES_TEST_BULK_SECRET_ACCESS_KEY: 'test-secret',
        },
      },
    })),
  ],
  test: { setupFiles: ['./test/apply-migrations.ts'] },
});
