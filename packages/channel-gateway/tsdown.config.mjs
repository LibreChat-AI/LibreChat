import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: [
    'src/client.ts',
    'src/config.ts',
    'src/events.ts',
    'src/slack.ts',
    'src/render.ts',
    'src/identity.ts',
    'src/review.ts',
  ],
  platform: 'node',
  format: ['cjs'],
  dts: false,
  outDir: 'dist',
  clean: true,
  checks: { circularDependency: true },
  deps: { alwaysBundle: () => true },
});
