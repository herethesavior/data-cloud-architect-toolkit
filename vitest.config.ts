import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@dcat/core': fromRoot('./packages/core/src/index.ts'),
      '@dcat/salesforce-cli': fromRoot('./packages/salesforce-cli/src/index.ts'),
      '@dcat/data360-api': fromRoot('./packages/data360-api/src/index.ts'),
      '@dcat/exporters': fromRoot('./packages/exporters/src/index.ts'),
      '@dcat/test-fixtures': fromRoot('./packages/test-fixtures/src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'apps/**/*.test.tsx'],
    setupFiles: ['./vitest.setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['packages/**/src/**/*.ts', 'apps/**/src/**/*.ts'],
    },
  },
});
