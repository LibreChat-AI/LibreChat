import path from 'node:path';
import { defineConfig } from 'tsdown';

const isMarkdownParserDependency = (id) =>
  /^(?:mdast-util-|micromark(?:-|$)|decode-named-character-reference$|devlop$|longest-streak$|unist-util-|zwitch$|character-(?:entities|reference)(?:-|$)|parse-entities$|stringify-entities$|is-(?:alphanumerical|alphabetical|decimal|hexadecimal)$|ccount$|markdown-table$|escape-string-regexp$)/.test(
    id,
  );

export default defineConfig({
  entry: ['src/index.ts', 'src/admin/capabilities.ts'],
  format: ['esm', 'cjs'],
  platform: 'node',
  dts: { oxc: true },
  outDir: 'dist',
  sourcemap: true,
  // Warn on module cycles at build time; CI enforces via config/circular-deps.mjs.
  checks: { circularDependency: true },
  // Externalize third-party deps consumers provide, while bundling `dotenv` for its
  // env-loading side effect and the ESM-only Markdown parser for CommonJS consumers.
  // `neverBundle` is the 0.22 replacement for the deprecated `external`.
  deps: {
    alwaysBundle: isMarkdownParserDependency,
    neverBundle: (id) =>
      id !== 'dotenv' &&
      !id.startsWith('dotenv/') &&
      !isMarkdownParserDependency(id) &&
      !id.startsWith('.') &&
      !id.startsWith('~') &&
      !path.isAbsolute(id),
    // dotenv is bundled on purpose, so silence the "detected dependencies in bundle" hint.
    onlyBundle: false,
  },
});
