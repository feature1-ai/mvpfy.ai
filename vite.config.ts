import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Renderer build only; the Electron main/preload processes are compiled
// separately via tsconfig.electron.json.
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
