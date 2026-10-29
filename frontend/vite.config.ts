import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  // The backend port is configured in the .env file in the repository root
  let { PORT } = loadEnv(mode, '..', '');
  if (!PORT) {
    PORT = '8000';
    console.warn('PORT is not set in the .env file, assuming the backend uses port 8000');
  }
  const backend = `http://localhost:${PORT}`;

  return {
    plugins: [react()],
    build: {
      outDir: '../dist',
      emptyOutDir: true
    },
    server: {
      proxy: {
        '/api': backend,
        '/common': backend
      }
    }
  };
});
