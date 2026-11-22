import { defineConfig } from 'vite';

export default defineConfig({
  assetsInclude: ['**/*.wasm'],
  optimizeDeps: {
    exclude: ['quark-engine'],
  },
  server: {
    port: 5174,
  },
});
