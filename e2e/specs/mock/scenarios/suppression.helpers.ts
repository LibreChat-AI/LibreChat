import { createRequire } from 'node:module';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { repoRoot } from './lint.helpers';

export type Suppressions = Record<string, Record<string, { count: number }>>;
export const SUPPRESSIONS_FILE = 'eslint-suppressions.json';
export const suppressionsPath = resolve(repoRoot, SUPPRESSIONS_FILE);
export const ESLINT = resolve(repoRoot, 'node_modules/.bin/eslint');

export const readBaseline = (): Suppressions =>
  JSON.parse(readFileSync(suppressionsPath, 'utf8')) as Suppressions;

/** A scratch baseline in its own directory; ESLint and the runner both take a
 *  baseline's location as an argument, so nothing here writes into the tree. */
export function writeBaseline(content: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), 'lc-suppressions-')), SUPPRESSIONS_FILE);
  writeFileSync(path, `${JSON.stringify(content, null, 2)}\n`);
  return path;
}

/** lint-staged's config is CommonJS, so it is loaded the way lint-staged loads
 *  it. Executing it is the point: the assertion is about the real commands. A
 *  task may be a function — that is how a command opts out of having the staged
 *  filenames appended — so each one is resolved the way lint-staged resolves
 *  it, with the staged list. */
export type HookTask = string | ((files: string[]) => string | string[]);

export const loadHookConfig = (path: string, staged: string[]): Record<string, string[]> => {
  const config = createRequire(__filename)(path) as Record<string, HookTask[]>;
  return Object.fromEntries(
    Object.entries(config).map(([pattern, tasks]) => [
      pattern,
      tasks.flatMap((task) => (typeof task === 'function' ? task(staged) : task)),
    ]),
  );
};

/**
 * A miniature repository the runner can be pointed at: its own copy of this
 * script, the real flat config, the real manifests and a symlinked
 * `node_modules`, over two client sources and one library source. `ROOT` is
 * derived from the script's own location, so the copy treats this tree as the
 * repository — which is what makes a roots sweep affordable to assert.
 *
 * The bundle is written last, holding exactly what the library's manifest
 * promises, so the runner reads the design metadata as current and does not
 * rebuild; the rules still resolve the real primitives through the symlinked
 * `node_modules`.
 */
export function syntheticRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'lc-synthetic-root-'));
  const write = (relative: string, content: string): void => {
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  };
  const copy = (relative: string): void => {
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    copyFileSync(resolve(repoRoot, relative), path);
  };

  for (const file of [
    'scripts/static-checks.mts',
    'scripts/diagnostics.mts',
    /** The suppressions check runs the comparison's spec before it reads the baseline. */
    'scripts/diagnostics.test.mts',
    'scripts/i18n.mts',
    'scripts/typecheck.mts',
    'scripts/imports.mts',
    'scripts/casing.mts',
    /** The local design rules the config registers and the runner validates against. */
    'scripts/eslint/design.mjs',
    'scripts/eslint/chat.mjs',
    'package.json',
    'package-lock.json',
    'eslint.config.mjs',
    'packages/client/package.json',
    'packages/client/tsdown.config.mjs',
    'packages/client/tsconfig.json',
    /** The lane this runner mirrors: the filter-parity check reads it, and the
     *  copy is what a scenario can break without touching the checkout. */
    '.github/workflows/static-checks.yml',
  ]) {
    copy(file);
  }
  symlinkSync(resolve(repoRoot, 'node_modules'), join(root, 'node_modules'), 'dir');

  /** One caller that violates a design rule and is recorded nowhere, one that is
   *  clean and recorded with slack: between them, a sweep of the roots is the
   *  only run that can report both. */
  write('client/src/Caller.tsx', 'export default () => <div className="bg-pink-500" />;\n');
  write('client/src/Clean.tsx', 'export default () => <div className="bg-surface-primary" />;\n');
  write('client/src/Other.tsx', 'export default () => <div className="bg-surface-primary" />;\n');
  write('client/src/components/ui/Thing.tsx', 'export const Thing = () => null;\n');
  write('packages/client/src/Primitive.tsx', 'export const Primitive = () => null;\n');
  /** The third root `lint:design:record` names; ESLint fails on a root that matches nothing. */
  write('packages/chat/src/index.ts', 'export {};\n');
  /** A spec beside each of them, under both metadata roots. The real roots are
   *  full of these — every primitive in `packages/client/src/components` has
   *  one — and the flat config turns every design rule off inside them, so what
   *  the gate does when one changes is a question the checkout asks constantly.
   *  Written before the bundle, so the miniature build still reads as current. */
  write('packages/client/src/Primitive.spec.tsx', 'export const fixture = null;\n');
  write('client/src/components/ui/Thing.spec.tsx', 'export const fixture = null;\n');
  for (const entry of bundleEntries()) write(join('packages/client', entry), 'export {};\n');
  write(
    SUPPRESSIONS_FILE,
    `${JSON.stringify({ 'client/src/Clean.tsx': { 'shadcn/no-restyle': { count: 2 } } }, null, 2)}\n`,
  );
  return root;
}

/**
 * What `packages/client/package.json` promises inside `dist`: its entry fields
 * and every string leaf of `exports` except a subpath pattern, which names no
 * single file. A build is only finished when these are there, which is what the
 * runner checks and what the miniature repository has to reproduce to stand in
 * for one.
 */
export function bundleEntries(): string[] {
  const manifest = JSON.parse(
    readFileSync(resolve(repoRoot, 'packages/client/package.json'), 'utf8'),
  ) as Record<string, unknown>;
  const declared: string[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === 'string') {
      const path = value.replace(/^\.\//, '');
      if (path.startsWith('dist/') && !path.includes('*')) declared.push(path);
      return;
    }
    if (typeof value === 'object' && value !== null) Object.values(value).forEach(collect);
  };
  for (const field of ['main', 'module', 'types', 'exports']) collect(manifest[field]);
  return [...new Set(declared)];
}
