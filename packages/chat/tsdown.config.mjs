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
