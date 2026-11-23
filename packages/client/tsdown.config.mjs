import path from 'node:path';
import { readdir, utimes } from 'node:fs/promises';
import { defineConfig } from 'tsdown';

// Mirror the prior Rollup `@rollup/plugin-replace` substitutions: only these three are
// baked at lib-build time. `import.meta.env.MODE` and `REACT_APP_*` are intentionally left
// intact so the consuming Vite app resolves them at app-build time.
const define = {
  'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'production'),
  'process.env.VITE_ENABLE_LOGGER': JSON.stringify(process.env.VITE_ENABLE_LOGGER || 'false'),
  'process.env.VITE_LOGGER_FILTER': JSON.stringify(process.env.VITE_LOGGER_FILTER || ''),
};

const copy = [
  // The color tokens ship as CSS: an app imports `@librechat/client/theme.css` into the
  // stylesheet that imports Tailwind, and gets `bg-surface-primary` and the rest. `to` names
  // the destination directory, not the file, pointing it at `dist/theme.css` produced a
  // directory of that name holding `tokens.css`, and the export resolved to a folder, so the
  // file keeps its name in `dist` and the export maps `./theme.css` onto it. It imports the stock
  // values and the font faces beside it by relative path, and the faces load `fonts/`, so all of
  // them ship side by side.
  { from: 'src/theme/tokens.css', to: 'dist' },
  { from: 'src/theme/defaults.css', to: 'dist' },
  { from: 'src/theme/fonts.css', to: 'dist' },
  { from: 'src/theme/fonts', to: 'dist' },
];

/** Sets each copied output, and everything under a copied directory, to the current time. */
async function touchCopies() {
  const now = new Date();
  const touch = async (target) => {
    await utimes(target, now, now);
    const entries = await readdir(target, { withFileTypes: true }).catch(() => []);
    await Promise.all(entries.map((entry) => touch(path.join(target, entry.name))));
  };
  await Promise.all(
    copy.map(({ from, to }) => touch(path.resolve(import.meta.dirname, to, path.basename(from)))),
  );
}

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  platform: 'browser',
  dts: { oxc: true },
  outDir: 'dist',
  sourcemap: true,
  // Warn on module cycles at build time; CI enforces via config/circular-deps.mjs.
  checks: { circularDependency: true },
  // Force .mjs/.cjs (and .d.mts/.d.cts) regardless of package `type`, so the package can stay
  // CommonJS (jest.config.js / babel.config.js are CJS) while still shipping dual ESM/CJS.
  fixedExtension: true,
  define,
  copy,
  // `fs.cp` keeps the source's mtime on some platforms (Windows `CopyFileW`), so a copied file
  // would never look newer than the sources the static checks compare `dist` against, and the
  // pre-commit hook would reject every commit after a checkout however often it rebuilt. Stamp
  // the copies once they land so a successful build always leaves `dist` fresh.
  hooks: { 'build:done': () => touchCopies() },
  // Extract all component CSS into a single `dist/style.css` (no import left in the JS, so the
  // CJS output stays valid CommonJS). Consumers import `@librechat/client/style.css` once.
  css: { inject: false },
  // Externalize every third-party import (consumers provide the peers + react/jsx-runtime);
  // bundle only relative, `~`-aliased, and absolute sources.
  deps: {
    neverBundle: (id) => !id.startsWith('.') && !id.startsWith('~') && !path.isAbsolute(id),
    onlyBundle: false,
  },
});
