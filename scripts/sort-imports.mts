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
 *
 * Long named value and type imports are compacted automatically when references can be
 * rewritten safely. Check mode enforces the same cleanup without writing.
 */

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join, relative, resolve, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compactImports } from './imports/compact.mts';

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
function sortSegment(stmts: Stmt[]): Stmt[] {
  const g1 = stmts
    .filter((s) => !s.isType && !s.isLocal)
    .sort((a, b) => {
      const aReact = a.spec === 'react' ? 0 : 1;
      const bReact = b.spec === 'react' ? 0 : 1;
      if (aReact !== bReact) return aReact - bReact;
      return a.len - b.len;
    });
  const g2 = stmts.filter((s) => s.isType && !s.isLocal).sort((a, b) => b.len - a.len);
  const g3 = stmts.filter((s) => s.isType && s.isLocal).sort((a, b) => b.len - a.len);
  const g4 = stmts.filter((s) => !s.isType && s.isLocal).sort((a, b) => b.len - a.len);
  return [...g1, ...g2, ...g3, ...g4];
}

interface SortedImports {
  content: string;
  valueOrderChanged: boolean;
}

function sortFileImports(content: string): SortedImports {
  const lines = content.split('\n');

  if (lines.some((line) => IGNORE_MARKER.test(line))) {
    return { content, valueOrderChanged: false };
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
      t.startsWith("'use ") ||
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
  let valueOrderChanged = false;

  const flushSegment = (): void => {
    if (segment.length === 0) return;
    const sorted = sortSegment(segment);
    const originalValues = segment.filter((statement) => !statement.isType);
    const sortedValues = sorted.filter((statement) => !statement.isType);
    valueOrderChanged ||= sortedValues.some(
      (statement, index) => statement !== originalValues[index],
    );
    emitted.push(...sorted.map((statement) => statement.raw));
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

  if (originalRaws.length < 2 || originalRaws.join('\n') === emitted.join('\n')) {
    return { content, valueOrderChanged: false };
  }

  return {
    content: [...lines.slice(0, importStart), ...emitted, ...lines.slice(importEnd)].join('\n'),
    valueOrderChanged,
  };
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

const { printWidth } = JSON.parse(await readFile(resolve(ROOT, '.prettierrc'), 'utf8')) as {
  printWidth: number;
};

let changed = 0;
let total = 0;

for (const filePath of await collectFiles()) {
  const rel = relative(ROOT, filePath);
  const content = await readFile(filePath, 'utf8');
  const sorted = sortFileImports(content).content;
  let result = sorted;
  if (!content.split('\n').some((line) => IGNORE_MARKER.test(line))) {
    const compacted = compactImports(sorted, filePath, printWidth);
    if (compacted !== sorted) {
      const cleaned = sortFileImports(compacted);
      result = cleaned.valueOrderChanged
        ? sortFileImports(compactImports(sorted, filePath, printWidth, false)).content
        : cleaned.content;
    }
  }
  total++;
  if (result === content) continue;
  changed++;
  if (CHECK) {
    console.log(`  ✗ ${rel}`);
  } else {
    await writeFile(filePath, result);
    console.log(`  ✓ ${rel}`);
  }
}

if (CHECK && changed) {
  console.log(`\n${changed}/${total} files need cleanup. Run: npm run sort-imports -- <files>`);
  process.exit(1);
} else if (changed) {
  console.log(`\nCleaned ${changed}/${total} files.`);
} else {
  console.log(`All ${total} files already clean.`);
}
