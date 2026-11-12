import { defineConfig, loadEnv, type ProxyOptions } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  const backendOrigin = (env.BACKEND_ORIGIN?.trim() || 'http://localhost:8082').replace(/\/$/, '');

  // Basemap tiles come straight from the OpenStreetMap tile servers, so no tile proxy
  // and no API key are needed; only the Java backend is proxied.
  const proxy: Record<string, string | ProxyOptions> = {
    '/backend': {
      target: backendOrigin,
      changeOrigin: true,
      rewrite: (path) => path.replace(/^\/backend/, ''),
    },
  };

  return {
    server: { proxy },
    preview: { proxy },
  };
});
