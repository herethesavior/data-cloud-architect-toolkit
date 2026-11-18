import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const connectorPort = process.env.DCAT_PORT ?? '3847';

export default defineConfig({
  root: fromRoot('./'),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@dcat/core': fromRoot('../../packages/core/src/index.ts'),
      '@dcat/salesforce-cli': fromRoot('../../packages/salesforce-cli/src/index.ts'),
      '@dcat/data360-api': fromRoot('../../packages/data360-api/src/index.ts'),
      '@dcat/exporters': fromRoot('../../packages/exporters/src/index.ts'),
      '@dcat/test-fixtures': fromRoot('../../packages/test-fixtures/src/index.ts'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${connectorPort}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
