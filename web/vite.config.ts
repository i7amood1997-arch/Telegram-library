import { defineConfig } from 'vite';

// Relative base so the site works under any GitHub Pages path (/<repo>/).
export default defineConfig({
  base: './',
  build: { target: 'es2022', sourcemap: false },
  worker: { format: 'es' },
});
