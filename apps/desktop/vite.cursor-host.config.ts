import { defineConfig } from 'vite';
export default defineConfig({
  build: {
    rollupOptions: {
      external: ['@cursor/sdk', 'node:module'],
      output: { inlineDynamicImports: true },
    },
  },
});
