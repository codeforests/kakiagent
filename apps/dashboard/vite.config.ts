import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

// The dashboard talks to the api and realtime roles same-origin: through this proxy
// locally, through CloudFront path routing in AWS (architecture §7). Targets come from
// apps/dashboard/.env (see .env.example).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react()],
    server: {
      port: Number(env.DASHBOARD_PORT ?? 5173),
      strictPort: true,
      proxy: {
        '/api': { target: env.API_PROXY_TARGET ?? 'http://localhost:3000', changeOrigin: false },
        '/ws': { target: env.REALTIME_PROXY_TARGET ?? 'ws://localhost:3001', ws: true },
      },
    },
  };
});
