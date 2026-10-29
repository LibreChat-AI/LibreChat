import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/main.ts'],
  platform: 'node',
  format: ['cjs'],
  dts: false,
  outDir: 'dist',
  clean: true,
  checks: { circularDependency: true },
  deps: { alwaysBundle: () => true },
});
