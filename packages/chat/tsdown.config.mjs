import path from 'node:path';
import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    react: 'src/react.ts',
    components: 'src/components.ts',
  },
  format: ['esm', 'cjs'],
  platform: 'browser',
  dts: { oxc: true },
  outDir: 'dist',
  // One file per source module. A bundled entry is a single module to the app's bundler, which
  // cannot split it, so code the entry shares with a lazy chunk (the message list) would ride in
  // with every page. The app groups the modules it loads at boot (see `chat-boot` in its Vite
  // config), so this does not add requests.
  unbundle: true,
  sourcemap: true,
  checks: { circularDependency: true },
  // Same as @librechat/client: the package stays CommonJS for its jest and babel configs while
  // shipping .mjs/.cjs pairs.
  fixedExtension: true,
  // Every third-party import is a peer the consuming app provides; only the package's own
  // relative sources are bundled.
  deps: {
    neverBundle: (id) => !id.startsWith('.') && !path.isAbsolute(id),
    onlyBundle: false,
  },
});
