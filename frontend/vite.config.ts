import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    // Fonts stay files: the security policy (font-src 'self', frontend/nginx.conf) refuses fonts
    // inlined as data: URLs, which Vite would otherwise do for the small font subsets.
    assetsInlineLimit: (file) => (/\.(woff2?|ttf|otf)$/i.test(file) ? false : undefined),
  },
  server: {
    proxy: {
      '/api': 'http://localhost:5000',
    },
  },
});
