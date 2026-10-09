#!/usr/bin/env node
/**
 * Sorts imports across the LibreChat monorepo per project convention
 * (AGENTS.md § Code style and performance):
 *
 *   1. Package value imports     — shortest line to longest (`react` always first)
 *   2. import type from packages — longest line to shortest
 *   3. import type from local    — longest line to shortest
 *   4. Local value imports       — longest line to shortest
 *
 * "Local" covers relative paths (`./`, `../`) and the workspace path aliases
 * (`~/`, `src/`, `test/`). Workspace packages such as `librechat-data-provider`
 * and `@librechat/*` are treated as package imports, not local.
 *
 * Runs on Node 24+ via native type-stripping (`.mts` keeps ESM semantics under
 * the CommonJS repo root):
 *
 *   Run:        npm run sort-imports
 *   Check only: npm run sort-imports:check
 *   Targeted:   node scripts/sort-imports.mts path/to/file.ts [...]
 */

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join, relative, resolve, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Source roots scanned when no explicit files are passed. */
const SOURCE_ROOTS = [
  'api',
  'client/src',
  'packages/api/src',
  'packages/data-provider/src',
  'packages/data-schemas/src',
  'packages/client/src',
];

const SOURCE_DIRS = SOURCE_ROOTS.map((rel) => resolve(ROOT, rel));
const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'];
const SKIP_DIR_NAMES = new Set([
  'node_modules',
  'dist',
  'types',
  'coverage',
  '.turbo',
  'data',
  'demo',
]);

const args = process.argv.slice(2);
const CHECK = args.includes('--check');
const FILE_ARGS = args.filter((arg) => !arg.startsWith('--'));

const LOCAL_PREFIXES = ['~/', 'src/', 'test/', './', '../'];

/** Per-file opt-out for modules where import order is load-bearing. */
const IGNORE_MARKER = /^\s*\/\/\s*sort-imports-ignore\b/;

function isLocal(spec: string): boolean {
  return LOCAL_PREFIXES.some((prefix) => spec.startsWith(prefix));
}

function hasSourceExtension(path: string): boolean {
  return EXTENSIONS.some((ext) => path.endsWith(ext));
}

function isUnderSourceDir(abs: string): boolean {
  return SOURCE_DIRS.some((dir) => abs === dir || abs.startsWith(`${dir}${sep}`));
}

interface Stmt {
  raw: string;
  spec: string;
  isType: boolean;
  isLocal: boolean;
  len: number;
}

function extractSpec(raw: string): string | null {
  return raw.match(/from\s+['"]([^'"]+)['"]/)?.[1] ?? null;
}

/** Applies the AGENTS.md grouping/length ordering to a run of pure imports. */
function sortSegment(stmts: Stmt[]): string[] {
  const g1 = stmts
    .filter((s) => !s.isType && !s.isLocal)
    .sort((a, b) => {
      const aReact = a.spec === 'react' ? 0 : 1;
      const bReact = b.spec === 'react' ? 0 : 1;
      if (aReact !== bReact) return aReact - bReact;
      return a.len - b.len;
    });
  const g2 = stmts
    .filter((s) => s.isType && !s.isLocal)
    .sort((a, b) => b.len - a.len);
  const g3 = stmts
    .filter((s) => s.isType && s.isLocal)
    .sort((a, b) => b.len - a.len);
  const g4 = stmts
    .filter((s) => !s.isType && s.isLocal)
    .sort((a, b) => b.len - a.len);
  return [...g1, ...g2, ...g3, ...g4].map((s) => s.raw);
}

function sortFileImports(content: string): string | null {
  const lines = content.split('\n');

  if (lines.some((line) => IGNORE_MARKER.test(line))) {
    return null;
  }

  let i = 0;
  while (i < lines.length) {
    const t = lines[i].trimStart();
    if (
      t === '' ||
      t.startsWith('//') ||
      t.startsWith('/*') ||
      t.startsWith('*') ||
      t.startsWith('*/') ||
      t.startsWith('\'use ') ||
      t.startsWith('"use ')
    ) {
      i++;
    } else {
      break;
    }
  }

  const importStart = i;
  // Side-effect imports (no `from` clause) are treated as immovable barriers:
  // sorting is confined to each contiguous run of pure imports between them, so
  // module-evaluation order around anything with side effects (polyfills,
  // registration, css, etc.) is never changed.
  const emitted: string[] = [];
  const originalRaws: string[] = [];
  let segment: Stmt[] = [];
  let importEnd = i;

  const flushSegment = (): void => {
    if (segment.length === 0) return;
    emitted.push(...sortSegment(segment));
    segment = [];
  };

  while (i < lines.length) {
    const t = lines[i].trimStart();
    if (!t.startsWith('import ') && !t.startsWith('import{')) break;

    let raw = lines[i];
    let j = i;
    while (!raw.includes(';') && j + 1 < lines.length) {
      j++;
      raw += '\n' + lines[j];
    }
    i = j + 1;
    importEnd = i;
    originalRaws.push(raw);

    const spec = extractSpec(raw);
    if (spec == null || spec === '') {
      flushSegment();
      emitted.push(raw);
      while (i < lines.length && lines[i].trim() === '') i++;
      continue;
    }

    segment.push({
      raw,
      spec,
      isType: /^import\s+type[\s{]/.test(raw.trimStart()),
      isLocal: isLocal(spec),
      len: raw
        .split('\n')
        .map((l) => l.trim())
        .join(' ').length,
    });

    while (i < lines.length && lines[i].trim() === '') i++;
  }
  flushSegment();

  if (originalRaws.length < 2) return null;
  if (originalRaws.join('\n') === emitted.join('\n')) return null;

  return [
    ...lines.slice(0, importStart),
    ...emitted,
    ...lines.slice(importEnd),
  ].join('\n');
}

/** Recursively yields absolute paths of every source file under `dir`. */
async function* walkSourceFiles(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      yield* walkSourceFiles(join(dir, entry.name));
    } else if (entry.isFile() && hasSourceExtension(entry.name)) {
      yield join(dir, entry.name);
    }
  }
}

/**
 * Resolves the set of files to process. When explicit paths are passed
 * (e.g. by lint-staged) only those source files under a known root are sorted;
 * otherwise every source file under each root is scanned.
 */
async function collectFiles(): Promise<string[]> {
  if (FILE_ARGS.length > 0) {
    return FILE_ARGS.map((file) => resolve(file)).filter(
      (abs) => hasSourceExtension(abs) && isUnderSourceDir(abs),
    );
  }

  const files: string[] = [];
  for (const dir of SOURCE_DIRS) {
    try {
      for await (const abs of walkSourceFiles(dir)) {
        files.push(abs);
      }
    } catch {
      continue;
    }
  }
  return files;
}

let changed = 0;
let total = 0;

for (const filePath of await collectFiles()) {
  const rel = relative(ROOT, filePath);
  const content = await readFile(filePath, 'utf8');
  const result = sortFileImports(content);
  total++;
  if (result === null) continue;
  changed++;
  if (CHECK) {
    console.log(`  ✗ ${rel}`);
  } else {
    await writeFile(filePath, result);
    console.log(`  ✓ ${rel}`);
  }
}

if (CHECK && changed) {
  console.log(`\n${changed}/${total} files need sorting. Run: npm run sort-imports`);
  process.exit(1);
} else if (changed) {
  console.log(`\nSorted ${changed}/${total} files.`);
} else {
  console.log(`All ${total} files already sorted.`);
}
