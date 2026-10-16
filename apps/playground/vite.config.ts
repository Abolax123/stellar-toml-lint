import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `base: './'` keeps the built playground usable from a static host and from a
// `file://` URL, which is how the offline review path is exercised.
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
