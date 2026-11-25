/**
 * Builds the outside host into `outDir` (first argument) with Vite and nothing else: no React
 * plugin, no Tailwind, no LibreChat config. It is what an app outside LibreChat would ship.
 */
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { build } from 'vite';

const root = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(process.argv[2] ?? resolve(root, 'dist'));

await build({
  root,
  configFile: false,
  logLevel: 'error',
  cacheDir: resolve(outDir, '.vite'),
  oxc: { jsx: { runtime: 'automatic' } },
  build: { outDir, emptyOutDir: true, chunkSizeWarningLimit: 100_000 },
});
