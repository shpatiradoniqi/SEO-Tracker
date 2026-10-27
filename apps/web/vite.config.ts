import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The browser only ever talks to Vite; /api is proxied so the session cookie is same-origin.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:3001' } },
  preview: { port: 5173, proxy: { '/api': 'http://127.0.0.1:3001' } },
});
