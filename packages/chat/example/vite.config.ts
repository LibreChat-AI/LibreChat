import path from 'node:path';
import { defineConfig } from 'vite';

const src = path.resolve(import.meta.dirname, '../src');

/**
 * Serves the example against the package's sources, so it runs without a package build. The
 * aliases mirror the package's `exports`; the example imports nothing else from the package.
 */
export default defineConfig({
  root: import.meta.dirname,
  resolve: {
    alias: [
      { find: /^@librechat\/chat$/, replacement: path.join(src, 'index.ts') },
      { find: /^@librechat\/chat\/(react|components)$/, replacement: path.join(src, '$1.ts') },
    ],
  },
});
