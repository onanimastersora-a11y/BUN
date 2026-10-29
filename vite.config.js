import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import webApp from './tools/vite-web-plugin.mjs';

// Two builds from the same source:
//   default      -> dist/            the Electron app (main window + pet window)
//   --mode web   -> web/public/app/  the web / iPhone app served at /app/
export default defineConfig(({ mode }) => {
  const web = mode === 'web';
  return {
    base: web ? '/app/' : './',
    plugins: [react(), web && webApp()],
    // Build outputs change while the dev server runs (installer, web deploy folder): don't watch them.
    server: { port: 5173, strictPort: true, watch: { ignored: ['**/release/**', '**/dist/**', '**/web/**'] } },
    build: {
      outDir: web ? 'web/public/app' : 'dist',
      emptyOutDir: true,
      rollupOptions: {
        input: web
          ? { main: resolve(import.meta.dirname, 'index.html') }
          : { main: resolve(import.meta.dirname, 'index.html'), pet: resolve(import.meta.dirname, 'pet.html') },
      },
    },
  };
});
