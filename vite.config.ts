import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The owner dashboard: a React app built to dist/client and served by the Worker as static assets.
export default defineConfig({
  root: 'client',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'client/src') } },
  build: { outDir: '../dist/client', emptyOutDir: true },
  server: { proxy: { '^/(api|login|signup|logout|authorize|oauth|mcp|u|v1|admin|health)': 'http://localhost:8787' } },
});
