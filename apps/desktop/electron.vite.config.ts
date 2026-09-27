import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['@centrate/shared'] })],
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ['@centrate/shared'] })],
  },
  renderer: {
    resolve: {
      alias: { '@renderer': resolve(__dirname, 'src/renderer/src') },
    },
    plugins: [react(), tailwindcss()],
  },
});
