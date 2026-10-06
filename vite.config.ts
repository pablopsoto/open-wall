import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig } from 'vite';

export default defineConfig({
  // Runs the Worker (image proxy, curation API, D1) inside the dev server too.
  plugins: [cloudflare()],
  build: { target: 'es2023', chunkSizeWarningLimit: 1200 },
  environments: {
    // Two pages: the wall and the curator.
    client: { build: { rollupOptions: { input: { main: 'index.html', admin: 'admin.html' } } } },
  },
});
