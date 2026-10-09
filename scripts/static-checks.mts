#!/usr/bin/env node
/**
 * Local equivalent of the "Static checks" CI job
 * (.github/workflows/static-checks.yml), scoped to the files in a diff.
 *
 * The job has two layers and this mirrors both. Per-file checks (ESLint,
 * Prettier, import order) run against the changed JS/TS files under `api/`,
 * `client/` and `packages/`. Tree-wide gates (config migration tests, unused
 * i18n keys, unused npm packages) run only when the diff touches the paths
 * that gate them in CI. Circular-dependency detection and the TypeScript
 * project checks come from the Backend Unit Tests workflow rather than the
 * Static Checks job, but they gate on a commit's paths the same way.
 *
 * Like the CI job, every selected check runs even after one fails, and the
 * failures are summarized at the end.
 *
 * The per-file checks see the exact staged content of a commit, because the
 * pre-commit hook runs them through lint-staged. The tree-wide gates read the
 * working tree, the same as running them by hand — reading the index instead
 * would mean materializing a second checkout with its own installs and builds.
 *
 * Runs on Node 24+ via native type-stripping (`.mts` keeps ESM semantics under
 * the CommonJS repo root):
 *
 *   Staged diff (what the pre-commit hook runs):
 *     npm run static-checks
 *   Add the slow gates (TypeScript, config tests, i18n, depcheck):
 *     npm run static-checks:full
 *   Against a base ref, the way CI sees a pull request:
 *     node scripts/static-checks.mts --against origin/dev
 *   A single commit:
 *     node scripts/static-checks.mts --commit HEAD
 *   Explicit files:
 *     node scripts/static-checks.mts packages/api/src/index.ts
 *
 * Flags: --staged, --full, --fast, --only <ids>, --skip <ids>, --verbose,
 * --list. Check ids: eslint, prettier, imports, eslint-config, json,
 * suppressions, css-colors, circular-deps, typecheck, config-tests, i18n, depcheck.
 */

import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  copyFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';

import type { Dirent } from 'node:fs';
import { isTranslationReferenced } from './i18n.mts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Path filters, mirroring the `dorny/paths-filter` block in
 * .github/workflows/static-checks.yml. A group is active when some changed
 * file matches one of its patterns and no exclusion (`!`) pattern.
 * Keep the two in sync — the workflow additionally defines a `runner` group
 * for its own smoke test of this script, which has no local counterpart.
 */
const FILTERS = {
  eslint: [
    'api/**',
    'client/**',
    'packages/**',
    'eslint.config.mjs',
    'eslint-suppressions.json',
    '.github/workflows/static-checks.yml',
    '!**.md',
  ],
  eslint_config: ['eslint.config.mjs', '.github/workflows/static-checks.yml'],
  // The design-rule backlog is data the lint reads, so a diff that only edits it
  // reaches no lintable file and would otherwise be checked by nothing.
  // Deleting or renaming a recorded file has to reach this group too: the entry
  // it leaves behind would silence whatever next takes that path.
  // Deleting or renaming a recorded file has to reach this group, and so does the
  // config: narrowing a rule or widening a contract changes how many violations
  // an entry stands for without touching a single source file.
  suppressions: [
    'eslint-suppressions.json',
    '**/eslint-suppressions.json',
    'client/src/**',
    'packages/client/src/**',
    /** The bundle the rules resolve primitives through is named by the library's
     *  manifest, produced by its build config and shaped by its compiler
     *  options. */
    'packages/client/package.json',
    'packages/client/tsdown.config.mjs',
    'packages/client/tsconfig.json',
    'eslint.config.mjs',
    /** The plugin is a dependency: a bump changes what the rules classify, and a
     *  removal takes the rules with it, neither of which touches a source file. */
    'package.json',
    'package-lock.json',
    /** This runner is the gate: `validateSuppressions` is what a recorded count
     *  is measured against, so a change to it has to run against the record. */
    'scripts/static-checks.mts',
    '.github/workflows/static-checks.yml',
    '!**.md',
  ],
  // Stylesheets are outside the design lint, which reads JSX.
  css_colors: [
    'client/src/*.css',
    'packages/client/src/*.css',
    'client/src/**/*.css',
    'packages/client/src/**/*.css',
    'packages/client/src/theme/allowlist.md',
    /** The scanner parses with postcss: an upgrade changes what it reads. */
    'package.json',
    'package-lock.json',
    'scripts/css-colors.test.mts',
    'scripts/css-colors.mts',
    'scripts/static-checks.mts',
    '.github/workflows/static-checks.yml',
  ],
  config: ['api/**', 'config/**', 'packages/**', '.github/workflows/static-checks.yml', '!**.md'],
  i18n: [
    'scripts/i18n*.mts',
    'scripts/static-checks.mts',
    'api/**',
    'client/src/**',
    'packages/client/**',
    'packages/data-provider/src/**',
    'packages/data-schemas/src/**',
    '.github/workflows/static-checks.yml',
    '!**.md',
  ],
  // Mirrors the Backend Unit Tests workflow, which owns both of these jobs.
  circular_deps: [
    'api/**',
    'packages/**',
    'package.json',
    'package-lock.json',
    'config/circular-deps.mjs',
    '.github/workflows/backend-review.yml',
    '!**.md',
  ],
  // The review workflows trigger their TypeScript jobs on the root manifests
  // too, since a dependency or @types bump can break compilation on its own.
  typecheck: [
    'client/**',
    'packages/**',
    'package.json',
    'package-lock.json',
    '.github/workflows/backend-review.yml',
    '.github/workflows/frontend-review.yml',
    '!**.md',
  ],
  unused_packages: [
    'api/**',
    'client/**',
    'packages/api/**',
    'packages/client/**',
    // Every workspace manifest PACKAGE_JSON_FILES validates, plus the ones
    // whose dependencies feed the unused-package calculation through
    // api/package.json's @librechat/data-schemas entry.
    'packages/data-provider/package.json',
    'packages/data-schemas/package.json',
    'package.json',
    'package-lock.json',
    '.github/workflows/static-checks.yml',
    '!**.md',
  ],
} as const;

type FilterName = keyof typeof FILTERS;

/** The same set the CI job lints, formats and import-sorts. */
const SOURCE_FILE_PATTERN = /^(api|client|packages)\/.*\.(js|jsx|ts|tsx)$/;

/** Files ESLint is pointed at when the flat config itself changes. */
const CONFIG_SMOKE_FILES = [
  'api/server/index.js',
  'client/src/main.jsx',
  'packages/api/src/index.ts',
];

const PACKAGE_JSON_FILES = [
  'package.json',
  'client/package.json',
  'api/package.json',
  'packages/api/package.json',
  'packages/client/package.json',
  'packages/data-provider/package.json',
  'packages/data-schemas/package.json',
];

/** The recorded design-rule backlog ESLint reads on every lint. */
const SUPPRESSIONS_FILE = 'eslint-suppressions.json';

/** Files per ESLint run when checking recorded counts: the whole baseline is
 *  hundreds of paths, and one argv has a platform limit. */
const SUPPRESSION_LINT_CHUNK = 150;

/** Sources the design rules read: the extensions ESLint lints, which is also
 *  what carries a primitive's `cva` variants. */
const DESIGN_SOURCE = /\.(?:ts|tsx|js|jsx)$/;

/** Sources that look like design sources and cannot be one. Every design rule is
 *  off inside a spec (`eslint.config.mjs`), and `packages/client/tsconfig.json`
 *  keeps specs out of the bundle the caller rules resolve primitives through, so
 *  a spec carries no `cva` variant to compare against and can report no design
 *  diagnostic of its own. Editing one moves no count, in its own file or
 *  anywhere else. */
const DESIGN_TEST_SOURCE = /\.(?:test|spec)\.(?:ts|tsx|js|jsx)$/;

/** What the design rules are configured by, and what they are installed from:
 *  narrowing a rule, widening a contract, or upgrading the plugin all change
 *  what every recorded count stands for, without touching a source file. */
const DESIGN_INPUTS = ['eslint.config.mjs', 'package.json', 'package-lock.json'];

/** Where the rules read component metadata from: the published library and the
 *  app-local path `componentImports` marks as a component source. A change in
 *  either moves what the caller rules report in files the diff never touches. */
const DESIGN_METADATA_ROOTS = ['packages/client/src/', 'client/src/components/ui/'];

/** The library's own manifest, build config and compiler options decide what is
 *  emitted into the bundle the rules resolve primitives through — the entry
 *  point, the `~/*` path mapping, what `include`/`exclude` leaves out — so they
 *  move what the caller rules report as surely as a `cva` variant does. The
 *  repository's own build caches key on `<package>/tsconfig*.json` for the same
 *  reason. */
const DESIGN_METADATA_FILES = [
  'packages/client/package.json',
  'packages/client/tsdown.config.mjs',
  'packages/client/tsconfig.json',
];

/** The two trees the design rules police, and what `lint:design:record` records. */
const DESIGN_ROOTS = ['client/src', 'packages/client/src'];

/**
 * This runner is the gate the record is measured against: `unusedCapacity` and
 * `inlineDirectives` decide which files a recorded count is compared with and
 * what counts as a hole. A change to them moves that verdict for every entry
 * while touching no source file and no config, so it revalidates the whole
 * record — the only way the change is exercised at all.
 */
const GATE_SOURCE = 'scripts/static-checks.mts';

/**
 * ESLint's on-disk suppressions shape, which the recorded baseline claims to be:
 * a count per file, per rule. `validateSuppressions` is what checks the claim, so
 * the leaf stays `unknown` — a string or a float there is one of the failures.
 */
type SuppressionsFile = Record<string, Record<string, { count?: unknown }>>;

/**
 * One file's entry in ESLint's JSON report, as the checks here read it. A
 * suppressed message carries its text too: the swap check compares messages,
 * and what the baseline silences is exactly what it has to see.
 */
type LintReport = {
  filePath: string;
  /** `message` also carries ESLint's unused-directive text, where `ruleId` is null. */
  messages: { ruleId: string | null; message?: string }[];
  suppressedMessages?: {
    ruleId: string | null;
    message?: string;
    suppressions?: { kind: string; justification?: string }[];
  }[];
};

/** A path in ESLint's report, as the repository names it. */
const reportedPath = (filePath: string): string =>
  filePath.startsWith(ROOT)
    ? filePath
        .slice(ROOT.length + 1)
        .split('\\')
        .join('/')
    : filePath;

/** `@shadcn/lint`'s rule map, the authority on which recorded rule names exist. */
type SuppressionsPlugin = { plugin: { rules: Record<string, unknown> } };

const I18N_FILE = 'client/src/locales/en/translation.json';
const I18N_SOURCE_DIRS = [
  'client/src',
  'api',
  'packages/data-provider/src',
  'packages/client',
  'packages/data-schemas/src',
];

const SOURCE_EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx'];
const IMPORT_EXTENSIONS = [...SOURCE_EXTENSIONS, '.mjs', '.cjs', '.mts', '.cts'];
const SKIP_DIR_NAMES = new Set(['node_modules', 'dist', 'coverage']);

/**
 * Batch limits, so a large diff cannot overflow the command line. Windows caps
 * a command line at 32767 characters — far below POSIX ARG_MAX — and a count
 * alone does not bound that: 400 of this repo's longer paths already approach
 * it, so the character budget is the real constraint and the count is a
 * secondary guard.
 */
const BATCH_SIZE = 400;
const BATCH_CHARS = 24000;

type Tier = 'fast' | 'slow';

interface CheckOutcome {
  ok: boolean;
  skipped?: string;
  output?: string;
  hints?: string[];
}

interface CheckContext {
  files: string[];
  sourceFiles: string[];
  groups: Record<FilterName, boolean>;
}

interface Check {
  id: string;
  title: string;
  tier: Tier;
  group: FilterName;
  run: (context: CheckContext) => CheckOutcome | Promise<CheckOutcome>;
}

/** A resolved tool invocation: `node <bin.js>` for a workspace package. */
interface Executable {
  command: string;
  args: string[];
  /** Windows resolves `.cmd` shims only through a shell. */
  shell?: boolean;
}

interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
  output: string;
}

function fail(message: string): never {
  console.error(`static-checks: ${message}`);
  process.exit(2);
}

function parseList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

const argv = process.argv.slice(2);

/** Every accepted flag, so a typo fails loudly instead of changing the run. */
const KNOWN_FLAGS = new Set([
  '--against',
  '--commit',
  '--only',
  '--skip',
  '--staged',
  '--full',
  '--fast',
  '--list',
  '--verbose',
]);

function readOption(name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) fail(`${name} requires a value`);
  return value;
}

const VALUED_OPTIONS = {
  against: readOption('--against'),
  commit: readOption('--commit'),
  only: readOption('--only'),
  skip: readOption('--skip'),
};

const OPTIONS = {
  against: VALUED_OPTIONS.against,
  commit: VALUED_OPTIONS.commit,
  only: parseList(VALUED_OPTIONS.only),
  skip: parseList(VALUED_OPTIONS.skip),
  list: argv.includes('--list'),
  verbose: argv.includes('--verbose'),
  full:
    argv.includes('--full') || (process.env.STATIC_CHECKS_FULL === '1' && !argv.includes('--fast')),
};

const OPTION_VALUES = new Set(
  Object.values(VALUED_OPTIONS).filter((value): value is string => value !== undefined),
);

const UNKNOWN_FLAGS = argv.filter((arg) => arg.startsWith('-') && !KNOWN_FLAGS.has(arg));
if (UNKNOWN_FLAGS.length > 0) {
  fail(`unknown option(s): ${UNKNOWN_FLAGS.join(', ')}`);
}

const FILE_ARGS = argv.filter((arg) => !arg.startsWith('-') && !OPTION_VALUES.has(arg));

/** Runs a command, capturing output so only failures have to be printed. */
function runCommand(executable: Executable, args: string[], cwd = ROOT): CommandResult {
  const result = spawnSync(executable.command, [...executable.args, ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: executable.shell === true,
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? (result.error ? `${result.error.message}\n` : '');
  return {
    status: result.error ? 1 : (result.status ?? 1),
    stdout,
    stderr,
    output: `${stdout}${stderr}`,
  };
}

/** Runs a command in batches so a large file list stays under the arg limit. */
function batchFiles(files: string[]): string[][] {
  const batches: string[][] = [];
  let batch: string[] = [];
  let length = 0;
  for (const file of files) {
    const cost = file.length + 1;
    const full = batch.length >= BATCH_SIZE || length + cost > BATCH_CHARS;
    // A single path longer than the budget still gets its own batch rather
    // than an empty one.
    if (batch.length > 0 && full) {
      batches.push(batch);
      batch = [];
      length = 0;
    }
    batch.push(file);
    length += cost;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

function runOnFiles(executable: Executable, args: string[], files: string[]): CommandResult {
  let status = 0;
  let stdout = '';
  let stderr = '';
  for (const batch of batchFiles(files)) {
    const result = runCommand(executable, [...args, ...batch]);
    if (status === 0) status = result.status;
    stdout += result.stdout;
    stderr += result.stderr;
  }
  return { status, stdout, stderr, output: `${stdout}${stderr}` };
}

const GIT: Executable = { command: 'git', args: [] };

const NPM: Executable =
  process.platform === 'win32'
    ? { command: 'npm.cmd', args: [], shell: true }
    : { command: 'npm', args: [] };

function captureStdout(executable: Executable, args: string[]): string {
  const result = runCommand(executable, args);
  if (result.status !== 0) {
    fail(`${executable.command} ${args.join(' ')} failed:\n${result.stderr}`);
  }
  return result.stdout;
}

const require = createRequire(import.meta.url);

/**
 * Resolves an installed package's executable to `node <entry>`, which works
 * the same on every platform — unlike the `node_modules/.bin` shims, which
 * Node refuses to spawn on Windows without a shell.
 */
function resolveBin(name: string, binName = name): Executable | null {
  try {
    const manifestPath = require.resolve(`${name}/package.json`, { paths: [ROOT] });
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      bin?: string | Record<string, string>;
    };
    const entry = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[binName];
    if (!entry) return null;
    return { command: process.execPath, args: [resolve(dirname(manifestPath), entry)] };
  } catch {
    return null;
  }
}

/**
 * A checker that cannot run is a failure, not a skip: reporting "all affected
 * static checks passed" without having linted anything is worse than saying
 * nothing. Only depcheck, which CI installs globally and this treats as
 * optional, is allowed to skip.
 */
function missingBin(name: string): CheckOutcome {
  return { ok: false, output: `${name} is not installed — run npm ci` };
}

function globToRegExp(pattern: string): RegExp {
  let source = '';
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        source += '.*';
        index++;
        continue;
      }
      source += '[^/]*';
      continue;
    }
    source += /[a-zA-Z0-9/_-]/.test(char) ? char : `\\${char}`;
  }
  return new RegExp(`^${source}$`);
}

const MATCHERS = new Map<string, RegExp>();

function matches(pattern: string, file: string): boolean {
  let matcher = MATCHERS.get(pattern);
  if (!matcher) {
    matcher = globToRegExp(pattern);
    MATCHERS.set(pattern, matcher);
  }
  return matcher.test(file);
}

/** `some-with-excludes`: some file matches an include and no exclusion. */
function groupIsActive(files: string[], patterns: readonly string[]): boolean {
  const includes = patterns.filter((pattern) => !pattern.startsWith('!'));
  const excludes = patterns
    .filter((pattern) => pattern.startsWith('!'))
    .map((pattern) => pattern.slice(1));
  return files.some(
    (file) =>
      includes.some((pattern) => matches(pattern, file)) &&
      !excludes.some((pattern) => matches(pattern, file)),
  );
}

interface Target {
  label: string;
  /** Every changed path, deletions included — this is what activates a group. */
  files: string[];
  /** Only paths the per-file checks can open, matching the CI job's file list. */
  existing: string[];
}

/**
 * Two lists, because CI derives two. `dorny/paths-filter` matches added,
 * modified AND deleted paths when it decides which checks are affected, while
 * the ESLint/Prettier/import-sort steps narrow to `--diff-filter=ACMRTUXB`
 * so they never hand a deleted path to a tool. Activating gates off the
 * narrowed list would let a delete-only commit — the last reference to a
 * translation key, say — slip past the i18n and depcheck gates.
 *
 * `--no-renames` is what makes a rename two paths. Git's rename detection
 * reports `git mv eslint-suppressions.json backlog.json` as the destination
 * alone, so the group that owns the source — the baseline that just
 * disappeared, the recorded design source that just left its root — is never
 * activated and nothing notices the departure. Selection is about which paths a
 * diff touches, and a rename touches both; the one place that wants the pairing
 * asks for it separately, with `--name-status -M`.
 */
function diffPaths(args: string[]): { files: string[]; existing: string[] } {
  const split = (output: string): string[] => output.split('\0').filter(Boolean);
  const named = [...args, '--no-renames'];
  return {
    files: split(captureStdout(GIT, named)),
    existing: split(captureStdout(GIT, [...named, '--diff-filter=ACMRTUXB'])),
  };
}

function resolveTarget(): Target {
  // Precedence would silently drop the losers: `--against origin/dev pkg.json`
  // checked only the file, and paired with --commit the base ref was never even
  // resolved, so a caller could believe a range had been checked.
  const selectors = [
    FILE_ARGS.length > 0 && 'file arguments',
    OPTIONS.commit && '--commit',
    OPTIONS.against && '--against',
    argv.includes('--staged') && '--staged',
  ].filter((selector): selector is string => typeof selector === 'string');
  if (selectors.length > 1) {
    fail(`${selectors.join(' and ')} cannot be combined — name the target once`);
  }

  if (FILE_ARGS.length > 0) {
    const files = FILE_ARGS.map((file) => relative(ROOT, resolve(file)).split('\\').join('/'));
    return { label: 'files from the command line', files, existing: files };
  }

  if (OPTIONS.commit) {
    // Paths come from the commit but contents come from the working tree, so
    // any other revision would be checked against the wrong file contents —
    // an added-then-deleted file would vanish, a since-modified one would be
    // read at its newer contents. Use --against for a range instead.
    const requested = captureStdout(GIT, [
      'rev-parse',
      '--verify',
      `${OPTIONS.commit}^{commit}`,
    ]).trim();
    const head = captureStdout(GIT, ['rev-parse', '--verify', 'HEAD^{commit}']).trim();
    if (requested !== head) {
      fail(
        `--commit ${OPTIONS.commit} (${requested.slice(0, 10)}) is not the checked-out commit ` +
          `(${head.slice(0, 10)}). These checks read the working tree, so check that commit out ` +
          `first, or use --against <ref> to scope by a range.`,
      );
    }
    // Contents still come from the working tree, so uncommitted edits would
    // be scored against the named commit — an invalid uncommitted package.json
    // failing a valid HEAD, or an uncommitted fix masking a defect in it.
    const dirty = captureStdout(GIT, ['status', '--porcelain', '--untracked-files=no']).trim();
    if (dirty) {
      fail(
        'these checks read the working tree, so --commit needs it to match the commit; ' +
          `${dirty.split('\n').length} tracked file(s) differ. Commit or restore them, or drop ` +
          '--commit to check the staged diff.',
      );
    }
    // -m is load-bearing: without it a merge commit yields no paths at all.
    return {
      label: `commit ${OPTIONS.commit}`,
      ...diffPaths([
        'diff-tree',
        '--root',
        '-m',
        '--no-commit-id',
        '-r',
        '-z',
        '--name-only',
        OPTIONS.commit,
      ]),
    };
  }

  if (OPTIONS.against) {
    // Three dots: diff from the merge base, not between the two tips. Once the
    // base branch advances, a two-dot diff reports its commits in reverse as
    // part of this target, activating gates for files the branch never touched.
    return {
      label: `${OPTIONS.against}...HEAD`,
      ...diffPaths(['diff', '-z', '--name-only', `${OPTIONS.against}...HEAD`]),
    };
  }

  return {
    label: 'staged diff',
    ...diffPaths(['diff', '-z', '--cached', '--name-only']),
  };
}

/** Recursively yields repo-relative paths of source files under `dir`. */
async function* walkSourceFiles(dir: string, extensions: string[]): AsyncGenerator<string> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Dot directories hold tooling, not product code, and one of them —
      // .claude/worktrees — can hold a full checkout per branch.
      if (entry.name.startsWith('.') || SKIP_DIR_NAMES.has(entry.name)) continue;
      yield* walkSourceFiles(path, extensions);
    } else if (entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext))) {
      yield path;
    }
  }
}

/** Every JS/TS-ish file under `dirs`, as absolute paths. */
async function collectFiles(dirs: string[], extensions: string[]): Promise<string[]> {
  const files: string[] = [];
  for (const dir of dirs) {
    for await (const file of walkSourceFiles(resolve(ROOT, dir), extensions)) {
      files.push(file);
    }
  }
  return files;
}

// --------------------------------------------------------------- per-file checks

function lintChangedFiles(context: CheckContext): CheckOutcome {
  if (context.sourceFiles.length === 0) {
    return { ok: true, skipped: 'no changed JS/TS files' };
  }
  const eslint = resolveBin('eslint');
  if (!eslint) return missingBin('eslint');
  const built = buildClientPackage();
  if (built) return built;

  // --no-warn-ignored: changed files under config-ignored paths
  // (e.g. packages/data-schemas/misc/**) must not fail --max-warnings=0.
  // --pass-on-unpruned-suppressions: the @shadcn/lint design rules run at error
  // against the recorded backlog in eslint-suppressions.json, and fixing one of
  // those violations leaves its suppression unused, which would otherwise fail the
  // very diff that fixed it. `npm run lint:design:prune` tightens the counts. The
  // CI step passes the same flag; a local run that failed here would be a lie about
  // what the pull request will do.
  const result = runOnFiles(
    eslint,
    [
      '--no-error-on-unmatched-pattern',
      '--config',
      'eslint.config.mjs',
      '--no-warn-ignored',
      '--max-warnings=0',
      '--pass-on-unpruned-suppressions',
      '--',
    ],
    context.sourceFiles,
  );
  return {
    ok: result.status === 0,
    output: result.output,
    hints: ['Fix automatically where possible with: npx eslint --fix <files>'],
  };
}

function checkFormatting(context: CheckContext): CheckOutcome {
  if (context.sourceFiles.length === 0) {
    return { ok: true, skipped: 'no changed JS/TS files' };
  }
  const prettier = resolveBin('prettier');
  if (!prettier) return missingBin('prettier');

  const result = runOnFiles(
    prettier,
    ['--check', '--no-error-on-unmatched-pattern', '--'],
    context.sourceFiles,
  );
  return {
    ok: result.status === 0,
    output: result.output,
    hints: ['Fix with: npx prettier --write <files>'],
  };
}

function checkImportOrder(context: CheckContext): CheckOutcome {
  if (context.sourceFiles.length === 0) {
    return { ok: true, skipped: 'no changed JS/TS files' };
  }
  const sortImports: Executable = {
    command: process.execPath,
    args: [resolve(ROOT, 'scripts/sort-imports.mts'), '--check'],
  };
  const result = runOnFiles(sortImports, [], context.sourceFiles);
  return {
    ok: result.status === 0,
    output: result.output,
    hints: [
      'Fix everything with:      npm run sort-imports',
      'Fix specific files with:  npm run sort-imports -- <files>',
    ],
  };
}

/**
 * The changed-file lint never loads a changed root config: a config-only diff
 * matches no lintable files, so even a malformed eslint.config.mjs would pass.
 * When the config changes, gate on it loading and applying to representative
 * sources. CI additionally runs a full-tree regression sweep, which is too
 * slow to be worth repeating locally.
 */
function validateEslintConfig(): CheckOutcome {
  const eslint = resolveBin('eslint');
  if (!eslint) return missingBin('eslint');
  const result = runCommand(eslint, ['--config', 'eslint.config.mjs', ...CONFIG_SMOKE_FILES]);
  return { ok: result.status === 0, output: result.output };
}

async function validatePackageJson(): Promise<CheckOutcome> {
  const invalid: string[] = [];
  for (const file of PACKAGE_JSON_FILES) {
    const path = resolve(ROOT, file);
    if (!existsSync(path)) continue;
    try {
      JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      invalid.push(`${file}: ${(error as Error).message}`);
    }
  }
  return { ok: invalid.length === 0, output: invalid.join('\n') };
}

/**
 * The design-rule backlog is the one input to `npm run lint` that is data rather
 * than code: ESLint loads `eslint-suppressions.json` on every run and silences up
 * to the count it records for each file and rule. The changed-file lint only ever
 * points ESLint at JS/TS sources, so a diff that edits the baseline alone reaches
 * no lintable file — nothing else reads it. Four ways it can stop saying what it
 * claims: a shape ESLint cannot load, a count no run can ever reach, a rule the
 * plugin does not define (a rename leaves the old key silencing nothing), and a
 * path that no longer exists, which is the entry `--prune-suppressions` clears and
 * which would otherwise silence a future file that reuses the path.
 *
 * A diff may carry a baseline that is not the repository's — a generated one, or
 * a second one under a lane's own directory — so every suppressions file the
 * target names is validated, and the repository's own is always among them.
 */
async function validateSuppressions(context: CheckContext): Promise<CheckOutcome> {
  const named = context.files.filter((file) => file.endsWith(`/${SUPPRESSIONS_FILE}`));
  // A diff that deletes a baseline still activates this group, and the
  // changed-file lint would see no source file to report through: the deletion
  // has to fail here rather than read as "nothing to validate". That holds for
  // a baseline under a lane's own directory as much as for the repository's:
  // what either one silences goes back to being reported, or stops being
  // reported, and no other step reads it.
  const missing = [SUPPRESSIONS_FILE, ...named].filter((file) => !existsSync(resolve(ROOT, file)));
  if (missing.length > 0) {
    return {
      ok: false,
      output: missing
        .map(
          (file) =>
            `${file} is missing: the design rules run at error against it, so removing it changes what they report and nothing else reads it.`,
        )
        .join('\n'),
      hints: ['Restore it, or re-record it with: npm run lint:design:suppress'],
    };
  }
  const targets = [SUPPRESSIONS_FILE, ...named];

  const problems: string[] = [];
  // Read the rule names from the plugin rather than listing them here, so a rule
  // this stack has not enabled yet is still a valid key and a renamed one is not.
  let known: Set<string>;
  try {
    const { plugin } = (await import('@shadcn/lint')) as SuppressionsPlugin;
    known = new Set(Object.keys(plugin.rules).map((rule) => `shadcn/${rule}`));
  } catch (error) {
    return { ok: false, output: `@shadcn/lint did not load: ${(error as Error).message}` };
  }

  /** Every lint below classifies against the primitives' `cva` variants, which
   *  the rules read through `packages/client/dist`. Built here rather than
   *  inside the capacity scan: the directive check lints first, and without the
   *  metadata it reports strictly fewer design diagnostics — so a comment
   *  silencing a `no-restyle` violation would be invisible in both of its runs. */
  const built = buildClientPackage();
  if (built) return built;

  problems.push(...workflowSelectsWhatItFilters());
  problems.push(...(await inlineDirectives(context)));
  for (const target of targets) {
    problems.push(...(await suppressionProblems(target, known)));
    problems.push(...(await unusedCapacity(target, context)));
  }

  return {
    ok: problems.length === 0,
    output: problems.join('\n'),
    hints: [
      'Drop entries for paths that moved or were fixed with: npm run lint:design:prune',
      'Re-record a moved file with: npm run lint:design:suppress',
    ],
  };
}

/**
 * The Static Checks lane names its files twice: once in `on.pull_request.paths`,
 * which decides whether the workflow runs at all, and once in the job's own
 * `suppressions` filter, which decides whether this check runs inside it. A
 * pattern in the second that no pattern in the first matches is a file this
 * gate claims to cover and CI never sees — a nested baseline outside the source
 * trees the trigger enumerates was exactly that.
 *
 * Asked here rather than in a spec because the file that breaks it is
 * `.github/workflows/static-checks.yml`, and this group is what a change to it
 * runs. A test in the mock Playwright lane cannot make that claim: that lane's
 * own trigger excludes `.github/workflows/**` apart from its own file, so a
 * workflow-only diff would never execute the assertion guarding it.
 */
function workflowSelectsWhatItFilters(): string[] {
  const path = '.github/workflows/static-checks.yml';
  let workflow: string;
  try {
    workflow = readFileSync(resolve(ROOT, path), 'utf8');
  } catch {
    return [`${path} could not be read; the lane it defines is what this check runs in`];
  }
  const { trigger, lane } = workflowFilters(workflow);
  if (trigger.length === 0 || lane.length === 0) {
    return [`${path}: the trigger or the suppressions filter could not be read`];
  }
  /** CI checks out LF, so a parser that only reads LF passes there and fails
   *  every commit on a Windows checkout with `core.autocrlf`, where the file
   *  arrives as CRLF. Reading the CRLF rendering here lets CI see that too. */
  const crlf = workflowFilters(workflow.replace(/\r?\n/g, '\r\n'));
  if (crlf.trigger.join('\n') !== trigger.join('\n') || crlf.lane.join('\n') !== lane.join('\n')) {
    return [`${path}: its filters read differently with CRLF line endings`];
  }
  /** GitHub's filter syntax, in the shapes both lists use: an exact path, a
   *  subtree, and a basename at any depth. */
  const starts = (file: string, pattern: string): boolean => {
    if (pattern.endsWith('/**')) return file.startsWith(`${pattern.slice(0, -3)}/`);
    if (pattern.startsWith('**/')) {
      const name = pattern.slice(3);
      return file === name || file.endsWith(`/${name}`);
    }
    return file === pattern;
  };
  return lane
    .map((pattern) => pattern.replace('**/', 'e2e/fixtures/').replace('/**', '/Probe.tsx'))
    .filter((file) => !trigger.some((pattern) => starts(file, pattern)))
    .map(
      (file) =>
        `${path}: the suppressions filter selects ${file}, which no \`on.pull_request.paths\` pattern starts the workflow for`,
    );
}

/** The `on.pull_request.paths` and `suppressions` pattern lists, exclusions
 *  dropped. Line endings are normalized first: every pattern below is anchored
 *  per line, and a `\r` left before the end of a line matches none of them. */
function workflowFilters(text: string): { trigger: string[]; lane: string[] } {
  const workflow = text.replace(/\r\n?/g, '\n');
  /** A block ends at its first sibling, which sits at the same indent: a
   *  terminator that only fires on shallower lines runs on through the next
   *  filter and reads its patterns as this one's. */
  const list = (section: RegExp, indent: number): string[] =>
    (workflow.split(section)[1] ?? '')
      .split(new RegExp(`^ {0,${indent}}\\S`, 'm'))[0]
      .split('\n')
      .map((line) => new RegExp(`^ {${indent + 2}}- '([^']+)'$`).exec(line)?.[1])
      .filter((pattern): pattern is string => Boolean(pattern) && !pattern.startsWith('!'));

  return { trigger: list(/^ {4}paths:$/m, 4), lane: list(/^ {12}suppressions:$/m, 12) };
}

/**
 * Design-rule violations belong in the record, where they are counted and can be
 * pruned; an inline comment is the one way to silence one that leaves nothing
 * behind to review. A file with no entry can carry one and pass every other
 * check here, so the diff's own sources are read for one, two ways.
 *
 * Asked of ESLint twice: the same files with and without `--no-inline-config`.
 * Any design-rule diagnostic that only the second run reports was silenced by a
 * comment, whatever its spelling. That is the runtime half, and it only ever
 * sees a comment that is silencing something today.
 *
 * The other half reads the comments themselves, out of the parser rather than
 * out of the text, so a string or a JSX attribute that looks like a directive is
 * not one: a disable naming a design rule, a blanket disable (which covers the
 * design rules whatever else it covers), and inline `eslint rule: severity`
 * configuration naming a design rule. None of those has to be suppressing
 * anything yet — a directive over a clean file silences the first violation
 * anyone adds, and ESLint's own unused-directive report cannot see a blanket one
 * that is busy silencing some other rule. Neither design root carries one today.
 *
 * Specs are left out. Every design rule is already off inside one, so a
 * directive there — blanket or named — takes no design diagnostic out of play
 * now or later, and rejecting it would be this gate failing a commit over a
 * comment about some other rule entirely.
 */
async function inlineDirectives(context: CheckContext): Promise<string[]> {
  const files = context.sourceFiles.filter(
    (file) =>
      DESIGN_SOURCE.test(file) &&
      !DESIGN_TEST_SOURCE.test(file) &&
      DESIGN_ROOTS.some((root) => file.startsWith(`${root}/`)) &&
      existsSync(resolve(ROOT, file)),
  );
  if (files.length === 0) return [];
  const eslint = resolveBin('eslint');
  if (!eslint) return [];

  /** A directive-suppressed diagnostic is still reported, under
   *  `suppressedMessages`, so the configured run counts only what the baseline
   *  silenced; everything an inline comment took out of play is then exactly the
   *  difference against the run that ignores inline configuration. */
  const count = (
    chunk: string[],
    extra: string[],
    baselineOnly: boolean,
  ): Map<string, number> | string => {
    const directory = mkdtempSync(join(tmpdir(), 'librechat-directives-'));
    const reportPath = join(directory, 'report.json');
    const result = runCommand(eslint, [
      '--no-error-on-unmatched-pattern',
      '--config',
      'eslint.config.mjs',
      '--no-warn-ignored',
      '--pass-on-unpruned-suppressions',
      ...extra,
      '--format',
      'json',
      '-o',
      reportPath,
      '--',
      ...chunk,
    ]);
    if (result.status > 1 || !existsSync(reportPath)) {
      rmSync(directory, { force: true, recursive: true });
      return `the design sources could not be linted for inline directives (exit ${result.status})`;
    }
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as LintReport[];
    rmSync(directory, { force: true, recursive: true });
    const counts = new Map<string, number>();
    for (const file of report) {
      const relative = reportedPath(file.filePath);
      const suppressed = (file.suppressedMessages ?? []).filter((message) =>
        baselineOnly
          ? message.suppressions?.every((suppression) => suppression.kind === 'file')
          : true,
      );
      for (const message of [...file.messages, ...suppressed]) {
        if (!message.ruleId?.startsWith('shadcn/')) continue;
        const key = `${relative}\u0000${message.ruleId}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    return counts;
  };

  const problems = new Set(await directiveComments(files));
  for (let index = 0; index < files.length; index += SUPPRESSION_LINT_CHUNK) {
    const chunk = files.slice(index, index + SUPPRESSION_LINT_CHUNK);
    const configured = count(chunk, [], true);
    if (typeof configured === 'string') return [configured];
    const ignored = count(chunk, ['--no-inline-config'], false);
    if (typeof ignored === 'string') return [ignored];
    for (const [key, total] of ignored) {
      if (total <= (configured.get(key) ?? 0)) continue;
      const [file, rule] = key.split('\u0000');
      problems.add(
        `${file}: ${rule} is silenced by an inline comment; record it in ${SUPPRESSIONS_FILE} instead, where the count is reviewable and \`npm run lint:design:prune\` can retire it`,
      );
    }
  }
  return [...problems];
}

/**
 * Every directive comment in the diff's design sources that takes a design rule
 * out of play, read from the parser's comment list so a string or a JSX
 * attribute that reads like one is not one. ESLint's description syntax (`--`)
 * is stripped first, so a justified directive is the same directive.
 *
 * A file ESLint cannot parse is left to ESLint, which reports it as a parse
 * error on its own account.
 */
async function directiveComments(files: string[]): Promise<string[]> {
  let parse: (code: string, options: Record<string, unknown>) => { comments?: { value: string }[] };
  try {
    ({ parse } = (await import('@typescript-eslint/parser')) as {
      parse: typeof parse;
    });
  } catch (error) {
    return [`the design sources could not be read for directives: ${(error as Error).message}`];
  }

  const problems: string[] = [];
  for (const file of files) {
    let comments: { value: string }[];
    try {
      const source = readFileSync(resolve(ROOT, file), 'utf8');
      comments =
        parse(source, { comment: true, jsx: true, loc: false, range: false }).comments ?? [];
    } catch {
      continue;
    }
    for (const comment of comments) {
      /** ESLint reads everything after ` -- ` as the author's justification. */
      const body = comment.value
        .trim()
        .split(/\s+--\s+/)[0]
        .trim();
      const disable = /^eslint-disable(?:-next-line|-line)?\b/.exec(body);
      if (disable) {
        const named = body
          .slice(disable[0].length)
          .split(',')
          .map((rule) => rule.trim())
          .filter(Boolean);
        if (named.length === 0) {
          problems.push(
            `${file}: a blanket \`${body}\` covers the design rules too, now or the first time this file violates one; record what is owed in ${SUPPRESSIONS_FILE} instead`,
          );
        }
        for (const rule of named.filter((rule) => rule.startsWith('shadcn/'))) {
          problems.push(
            `${file}: ${rule} is disabled by an inline comment; record it in ${SUPPRESSIONS_FILE} instead, where the count is reviewable and \`npm run lint:design:prune\` can retire it`,
          );
        }
        continue;
      }
      /** `/* eslint rule: severity *\/` does not suppress a violation, it turns
       *  the rule off for the file — dormant or not, that is the same hole.
       *
       *  ESLint reads what follows as an object literal, so a rule key is
       *  whatever the token decodes to, not how it is written:
       *  `shadcn/no-raw-colors`, `"shadcn/no-raw-colors"`,
       *  `"shadcn\/no-raw-colors"` and `"shadcn\u002fno-raw-colors"` are one
       *  key spelled four ways, and ESLint disables the rule for all four.
       *  Matching the spelling is what kept losing to the next one; decoding
       *  the token is what stops the question being about spelling at all. */
      if (!/^eslint\s/.test(body)) continue;
      for (const [, doubled, singled, bare] of body.matchAll(
        /(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([A-Za-z@][\w@\-./]*))\s*:/g,
      )) {
        const rule = decodeRuleKey(doubled ?? singled ?? bare ?? '');
        if (!rule.startsWith('shadcn/')) continue;
        problems.push(
          `${file}: ${rule} is configured by an inline comment; the record is where a design rule is answered, not the file that owes it`,
        );
      }
    }
  }
  return problems;
}

/**
 * One rule key from an inline `eslint` configuration comment, as ESLint reads
 * it rather than as it was typed. A quoted key is a JSON string, so its escapes
 * are part of the encoding and not of the name: `\/` and `\u002f` are both `/`.
 * An undecodable token is returned unchanged — ESLint would not honour it
 * either, and inventing a name here would invent a violation.
 */
function decodeRuleKey(token: string): string {
  if (!token.includes('\\')) return token;
  try {
    return JSON.parse(`"${token.replace(/\\'/g, "'").replace(/"/g, '\\"')}"`) as string;
  } catch {
    return token;
  }
}

/** Everything wrong with one recorded baseline, named by its own path. */
async function suppressionProblems(target: string, known: Set<string>): Promise<string[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(resolve(ROOT, target), 'utf8'));
  } catch (error) {
    return [`${target}: ${(error as Error).message}`];
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return [
      `${target}: expected an object keyed by file path, got ${Array.isArray(parsed) ? 'an array' : typeof parsed}`,
    ];
  }

  const problems: string[] = [];
  for (const [file, rules] of Object.entries(parsed as SuppressionsFile)) {
    const where = target === SUPPRESSIONS_FILE ? file : `${target} → ${file}`;
    if (typeof rules !== 'object' || rules === null || Array.isArray(rules)) {
      problems.push(`${where}: expected an object keyed by rule name`);
      continue;
    }
    if (!existsSync(resolve(ROOT, file))) {
      problems.push(`${where}: recorded path no longer exists`);
    }
    for (const [rule, entry] of Object.entries(rules)) {
      if (!known.has(rule)) {
        problems.push(`${where}: ${rule} is not a rule @shadcn/lint defines`);
      }
      const count = typeof entry === 'object' && entry !== null ? entry.count : undefined;
      if (typeof count !== 'number' || !Number.isInteger(count) || count < 1) {
        problems.push(
          `${where}: ${rule} records ${JSON.stringify(count) ?? 'nothing'} where a positive integer count belongs`,
        );
      }
    }
  }
  return problems;
}

/**
 * A recorded count that no longer matches the file is a hole in both
 * directions. Higher than the file's violations is capacity the next change can
 * spend: `--pass-on-unpruned-suppressions` keeps the diff that fixed a violation
 * committable, and nothing else asks for the count to come down, so a later
 * violation of the same rule in the same file is silenced by the slack. Lower
 * than the file's violations only fails while the file is in the changed-file
 * lint's scope; recorded against an untouched file it is a lint that starts
 * failing for whoever edits it next. A count against a path no design-rule lint
 * reaches at all is the third shape of the same hole: nothing spends it, the
 * prune never sees it, and it silences whatever is linted at that path later.
 *
 * The set checked is the files this diff touches plus the files whose entries it
 * edits — and everything recorded when the baseline is the only thing that
 * changed, since that edit is precisely the one nothing else re-reads, or when
 * the diff changes a component-library source, the rules' own config, the
 * manifests the plugin is installed from, or this runner: a primitive's
 * variants, the config's contracts, the plugin's version and the gate's own
 * rules each decide what every recorded count stands for. A baseline named in
 * the diff is always checked in full: what it silences is its whole purpose.
 */
async function unusedCapacity(target: string, context: CheckContext): Promise<string[]> {
  let recorded: SuppressionsFile;
  try {
    recorded = JSON.parse(await readFile(resolve(ROOT, target), 'utf8')) as SuppressionsFile;
  } catch {
    // Shape problems are reported by the validation above; nothing to add here.
    return [];
  }
  if (typeof recorded !== 'object' || recorded === null || Array.isArray(recorded)) return [];

  const touched = new Set(context.sourceFiles.filter((file) => recorded[file]));
  /** Entries this diff edits, including the ones it removes: dropping an entry
   *  while the file still violates the rule is the same hole wearing the other
   *  hat, and the changed-file lint only sees it if the file itself changed. */
  for (const file of editedEntries(target, context)) touched.add(file);
  /** Three kinds of change move counts in files the diff never touches, and
   *  nothing else re-reads those entries — the changed-file lint is scoped to
   *  the diff and the caller rules are off inside the library. A primitive's
   *  `cva` variants are what `no-restyle` compares a caller's className
   *  against; the config decides which classes each rule can classify at all;
   *  and this runner decides what a count has to match. Any of them validates
   *  the whole record.
   *
   *  A spec under either root is none of them: nothing it contains reaches the
   *  bundle or carries a variant, so it cannot move a caller's diagnostic and
   *  does not buy a two-root sweep. Both roots are full of them. */
  const wholeRecord = context.files.some(
    (file) =>
      file === GATE_SOURCE ||
      DESIGN_INPUTS.includes(file) ||
      DESIGN_METADATA_FILES.includes(file) ||
      (DESIGN_SOURCE.test(file) &&
        !DESIGN_TEST_SOURCE.test(file) &&
        DESIGN_METADATA_ROOTS.some((root) => file.startsWith(root))),
  );
  /** When the whole record is in question the targets are the roots themselves,
   *  not the recorded paths: a primitive's new contract can give a caller that
   *  never owed anything its first violation, and a file with no entry is
   *  exactly what enumerating the record cannot see. `touched` is unioned in so
   *  a path this diff removed from a nested baseline stays checked. */
  const files = (
    target !== SUPPRESSIONS_FILE
      ? /** A nested baseline is checked in full, and the entries this diff
         *  removed from it belong to that full set: the source they used to
         *  speak for still violates the rule, and nothing else re-reads it. */
        [...new Set([...Object.keys(recorded), ...touched])]
      : wholeRecord
        ? [...new Set([...DESIGN_ROOTS, ...touched])]
        : context.files.includes(target)
          ? /** The baseline is in the diff: what it silences is its whole
             *  purpose, so every path it records is read, not only the entries
             *  the diff moved. */
            [...new Set([...Object.keys(recorded), ...touched])]
          : [...touched]
  ).filter((file) => existsSync(resolve(ROOT, file)));
  if (files.length === 0) return [];
  /** The recorded paths this run put a question to. A root sweep asks about
   *  every one of them; otherwise it is the explicit list. Either way an entry
   *  ESLint then says nothing about is an entry that silences nothing, which is
   *  checked once the report is in. */
  const asked = (
    (target === SUPPRESSIONS_FILE && wholeRecord) || context.files.includes(target)
      ? Object.keys(recorded)
      : files
  ).filter((file) => recorded[file] && existsSync(resolve(ROOT, file)));

  const eslint = resolveBin('eslint');
  if (!eslint) return [`${target}: ESLint is not installed, so recorded counts cannot be checked`];
  const built = buildClientPackage();
  if (built) return [`${target}: ${built.output ?? 'the component library did not build'}`];

  /** Chunked by hand, each chunk's report read from its own file: concatenated
   *  JSON arrays cannot be rejoined safely — a rule message may contain `][` —
   *  and ESLint's exit status has to be read, because 2 means it never linted. */
  const report: LintReport[] = [];
  for (let index = 0; index < files.length; index += SUPPRESSION_LINT_CHUNK) {
    const chunk = files.slice(index, index + SUPPRESSION_LINT_CHUNK);
    const directory = mkdtempSync(join(tmpdir(), 'librechat-suppressions-'));
    const reportPath = join(directory, 'report.json');
    const result = runCommand(eslint, [
      '--no-error-on-unmatched-pattern',
      '--config',
      'eslint.config.mjs',
      '--no-warn-ignored',
      '--pass-on-unpruned-suppressions',
      /** Read the baseline under test, not the repository's: a nested one is
       *  checked against what it silences, not against what the root records. */
      '--suppressions-location',
      resolve(ROOT, target),
      '--format',
      'json',
      '-o',
      reportPath,
      '--',
      ...chunk,
    ]);
    if (result.status > 1 || !existsSync(reportPath)) {
      rmSync(directory, { force: true, recursive: true });
      return [
        `${target}: ESLint could not report on the recorded files (exit ${result.status}):\n${result.output}`,
      ];
    }
    report.push(...(JSON.parse(readFileSync(reportPath, 'utf8')) as LintReport[]));
    rmSync(directory, { force: true, recursive: true });
  }
  const problems: string[] = [];
  const reported = new Set(report.map((file) => reportedPath(file.filePath)));
  /** A recorded path ESLint does not report on is dormant, not clean: the flat
   *  config ignores it, or it lies outside the roots the rules police. Nothing
   *  spends that count today and nothing prunes it, so it is waiting for
   *  whatever is next linted at that path. */
  for (const file of asked) {
    if (reported.has(file)) continue;
    problems.push(
      `${file}: recorded but no design-rule lint reports on it — the flat config ignores it, or it is outside ${DESIGN_ROOTS.join(' and ')} — so the entry silences nothing and would silence whatever is linted at this path later`,
    );
  }
  problems.push(...(await introducedWithinAllowance(target, recorded, context, report)));
  for (const file of report) {
    const relative = reportedPath(file.filePath);
    const actual = new Map<string, number>();
    for (const message of [...file.messages, ...(file.suppressedMessages ?? [])]) {
      if (message.ruleId?.startsWith('shadcn/')) {
        actual.set(message.ruleId, (actual.get(message.ruleId) ?? 0) + 1);
      }
    }
    for (const [rule, count] of actual) {
      if (recorded[relative]?.[rule] === undefined && count > 0) {
        problems.push(
          `${relative}: ${rule} records nothing but the file has ${count}; the lint fails for whoever edits it next`,
        );
      }
    }
    for (const [rule, entry] of Object.entries(recorded[relative] ?? {})) {
      const count = typeof entry === 'object' && entry !== null ? entry.count : undefined;
      if (typeof count !== 'number') continue;
      const now = actual.get(rule) ?? 0;
      if (now < count) {
        problems.push(
          `${relative}: ${rule} records ${count} but the file now has ${now}; the unused ${count - now} would silence a later violation`,
        );
      }
      if (now > count) {
        problems.push(
          `${relative}: ${rule} records ${count} but the file now has ${now}; the ${now - count} beyond the record fail the lint for whoever edits it next`,
        );
      }
    }
  }
  return problems;
}

/**
 * The design-rule violations this diff adds to a file that already records some
 * and does not grow its record to cover them. The record is a budget per file
 * and rule, so swapping one raw colour for another keeps the total equal and
 * the changed-file lint suppresses the new one inside the old allowance — the
 * debt changes hands and nothing says so.
 *
 * What the count cannot distinguish, the diagnostics can: each file's version at
 * the base is linted as itself, through ESLint's API so one process answers for
 * the whole diff, and a message the head reports that the base did not is a
 * violation this change introduced. Introducing one is allowed when the record
 * says so out loud — the recipe in CLAUDE.md is to record what a change owes,
 * and a count that grows is a visible line in the diff — so what is reported is
 * the violations beyond that growth. A violation that only moved keeps its
 * message and is not reported; a file with no version at the base brings no
 * allowance with it; a renamed file brings the one its violations came with.
 *
 * Specs are left out: with every design rule off inside one, neither its base
 * nor its head version can report a design diagnostic, so fetching the base
 * version and linting it answers a question with one possible answer.
 */
async function introducedWithinAllowance(
  target: string,
  recorded: SuppressionsFile,
  context: CheckContext,
  head: LintReport[],
): Promise<string[]> {
  const changed = new Set(
    context.sourceFiles.filter(
      (file) =>
        DESIGN_SOURCE.test(file) &&
        !DESIGN_TEST_SOURCE.test(file) &&
        DESIGN_ROOTS.some((root) => file.startsWith(`${root}/`)),
    ),
  );
  const subjects = head.filter((file) => changed.has(reportedPath(file.filePath)));
  if (subjects.length === 0) return [];

  const baseRef = baseCommit();
  /** Where each file came from: a rename carries its violations with it, and
   *  asking for the new path at the base would call every one of them new. */
  const renames = new Map<string, string>();
  const renamed = runCommand(GIT, ['diff', '--name-status', '-M', baseRef, '--']);
  if (renamed.status === 0) {
    for (const line of renamed.stdout.split('\n')) {
      /** Trimmed: git's output carries CRLF on some checkouts, and a `\r` would
       *  key the map on a path no report ever names. */
      const [status, from, to] = line.trim().split('\t');
      if (status?.startsWith('R') && from && to) renames.set(to, from);
    }
  }

  /** Whether a file existed at the base, and under which name — asked of git,
   *  not inferred from its contents: a tracked empty file reads the same as a
   *  missing one, and a rename means both the source and the entry that speaks
   *  for it lived under the old path. A base commit that is not in this clone
   *  cannot answer at all, and saying so is better than calling every changed
   *  file new. */
  if (runCommand(GIT, ['cat-file', '-e', `${baseRef}^{commit}`]).status !== 0) {
    return [
      `the violations this change introduces could not be read: ${baseRef} is not in this clone, so nothing says what these files held before`,
    ];
  }
  const before = new Map<string, { path: string; source: string } | undefined>();
  for (const file of subjects) {
    const relative = reportedPath(file.filePath);
    const path = renames.get(relative) ?? relative;
    const source = runCommand(GIT, ['show', `${baseRef}:${path}`]);
    before.set(relative, source.status === 0 ? { path, source: source.stdout } : undefined);
  }

  let lintText: (source: string, options: { filePath: string }) => Promise<LintReport[]>;
  try {
    const { ESLint } = createRequire(import.meta.url)('eslint') as {
      ESLint: new (options: Record<string, unknown>) => {
        lintText: (source: string, options: { filePath: string }) => Promise<LintReport[]>;
      };
    };
    const instance = new ESLint({
      cwd: ROOT,
      overrideConfigFile: resolve(ROOT, 'eslint.config.mjs'),
      warnIgnored: false,
    });
    lintText = (source, options) => instance.lintText(source, options);
  } catch (error) {
    return [`the base versions could not be linted: ${(error as Error).message}`];
  }

  const signatures = (reports: LintReport[]): string[] =>
    reports
      .flatMap((file) => [...file.messages, ...(file.suppressedMessages ?? [])])
      .filter((message) => message.ruleId?.startsWith('shadcn/'))
      .map((message) => `${message.ruleId}: ${message.message ?? ''}`);

  /** The record as the base held it: how much an entry grew between there and
   *  here is what this change may add. A count that goes up is a line in the
   *  diff and the recipe CLAUDE.md documents; a count that stands still is the
   *  swap. A baseline the base cannot parse grants nothing, and the shape
   *  checks say why. */
  let recordedBefore: SuppressionsFile = {};
  const previousRecord = runCommand(GIT, ['show', `${baseRef}:${target}`]);
  if (previousRecord.status === 0) {
    try {
      recordedBefore = JSON.parse(previousRecord.stdout) as SuppressionsFile;
    } catch {
      recordedBefore = {};
    }
  }
  const countOf = (record: SuppressionsFile, file: string, rule: string): number => {
    const entry = record[file]?.[rule]?.count;
    return typeof entry === 'number' ? entry : 0;
  };

  const problems: string[] = [];
  for (const file of subjects) {
    const relative = reportedPath(file.filePath);
    const inheritedFrom = before.get(relative);
    /** A file the change adds owes everything in it: the record may not grow to
     *  cover a violation written in the same commit as its entry, or the rules
     *  would police nothing but the tree they landed on. A file that existed at
     *  the base — renamed or not — brings its allowance and may grow it, and a
     *  rename's allowance is the one recorded under the name it had. */
    const inherited = inheritedFrom !== undefined;
    const had = new Map<string, number>();
    if (inheritedFrom !== undefined) {
      /** Linted as the path it had, not the one it has: moving a component out
       *  of the library and into the app enters a stricter scope, and reading
       *  the old contents under the new path would let the destination's own
       *  diagnostics appear on both sides and pass as inherited. */
      const was = resolve(ROOT, inheritedFrom.path);
      for (const signature of signatures(await lintText(inheritedFrom.source, { filePath: was }))) {
        had.set(signature, (had.get(signature) ?? 0) + 1);
      }
    }
    const allowed = new Map<string, number>();
    for (const signature of signatures([file])) {
      const remaining = had.get(signature) ?? 0;
      if (remaining > 0) {
        had.set(signature, remaining - 1);
        continue;
      }
      /** Beyond what the base held: chargeable to this change unless the entry
       *  grew for that rule, and only as far as it grew. A renamed file's
       *  allowance is the one recorded under the name it had, or the move
       *  itself would read as room to spend. */
      const rule = signature.slice(0, signature.indexOf(':'));
      const grew =
        countOf(recorded, relative, rule) -
        countOf(recordedBefore, inheritedFrom?.path ?? relative, rule);
      const key = `${relative}\u0000${rule}`;
      const spent = allowed.get(key) ?? 0;
      if (inherited && spent < grew) {
        allowed.set(key, spent + 1);
        continue;
      }
      problems.push(
        inherited
          ? `${relative}: ${signature} is new here and the record did not grow to cover it; fix it, or record what this change owes with \`npm run lint:design:suppress\` so the count says so`
          : `${relative}: ${signature} is in a file this change adds; the backlog records what the tree owed when the rules landed, not what a new file brings, so fix it`,
      );
    }
  }
  return problems;
}

/**
 * The commit this change is measured against: the merge base of the requested
 * base and `HEAD` for a range, the checked commit's parent when one commit is
 * named, and `HEAD` for a staged run. A pull request's diff starts at the
 * merge base, so reading prior content from the base branch's tip instead
 * would call a violation that branch added since the divergence this change's
 * doing, and forgive one this change added that the tip happens to carry; and
 * `--commit HEAD` compared against `HEAD` would be the commit against itself,
 * which forgives everything. Resolved once, because two checks ask and they
 * have to agree.
 */
let resolvedBase: string | undefined;
function baseCommit(): string {
  if (resolvedBase !== undefined) return resolvedBase;
  if (OPTIONS.commit !== undefined) {
    const parent = runCommand(GIT, ['rev-parse', `${OPTIONS.commit}^`]);
    resolvedBase = parent.status === 0 ? parent.stdout.trim() : OPTIONS.commit;
    return resolvedBase;
  }
  const requested = OPTIONS.against ?? 'HEAD';
  const merged = runCommand(GIT, ['merge-base', requested, 'HEAD']);
  resolvedBase = merged.status === 0 ? merged.stdout.trim() : requested;
  return resolvedBase;
}

/**
 * The files whose recorded entries this diff edits, read by comparing the
 * baseline against the merge base. A mixed diff that leaves a file alone while
 * loosening its entry would otherwise be checked by nothing.
 */
function editedEntries(target: string, context: CheckContext): string[] {
  if (!context.files.includes(target)) return [];
  const base = runCommand(GIT, ['show', `${baseCommit()}:${target}`]);
  /** The base commit may not carry the baseline at all — the change that adds
   *  it is exactly one such diff — so this read must not be fatal. */
  if (base.status !== 0) return [];
  let previous: SuppressionsFile;
  try {
    previous = JSON.parse(base.stdout) as SuppressionsFile;
  } catch {
    return [];
  }
  let current: SuppressionsFile;
  try {
    current = JSON.parse(readFileSync(resolve(ROOT, target), 'utf8')) as SuppressionsFile;
  } catch {
    return [];
  }
  return [...new Set([...Object.keys(previous), ...Object.keys(current)])].filter(
    (file) => JSON.stringify(previous[file]) !== JSON.stringify(current[file]),
  );
}

/**
 * Whether `packages/client/dist` describes the current sources. A missing build
 * is the obvious case; a stale one is the quiet case — it reports variants that
 * no longer exist and misses the ones that do, which is a lint that disagrees
 * with CI while looking clean.
 *
 * Two things are asked, because a timestamp alone answers neither. What the
 * manifest declares has to be there: the build empties `dist` before it writes,
 * so a build that failed halfway leaves a recent directory over a bundle that
 * no longer has an entry point, and the newest mtime under it would read as
 * proof. And the build has to be newer than everything it is built from — the
 * library's manifest, build config and compiler options, which decide what is
 * emitted, and the root manifests, which decide what `build:client-package`
 * runs and which toolchain it runs with — while every file under `src` the
 * tsconfig actually emits stays older than the last build. CI always builds, so
 * either divergence would only appear locally.
 *
 * Freshness is asked of every declared output, not of the newest file anywhere
 * under `dist`. A resolver loads one entry, not the directory: a build that
 * rewrote the ESM bundle and left the CJS one or the type declarations behind
 * would pass a `max` comparison while `@shadcn/lint` reads the stale one and
 * classifies callers against variants that no longer exist. The weakest output
 * is the one that decides, which is the same reason their existence is checked
 * one by one rather than by the directory's mtime.
 *
 * Specs are not among those sources: `packages/client/tsconfig.json` excludes
 * them, so no edit to one can make the bundle describe something else. Adding or
 * deleting a spec still moves its directory's own mtime, which is read because a
 * deleted source leaves no file behind to be newer than the build; that errs
 * toward rebuilding, which is the safe direction.
 */
function designMetadataIsFresh(): boolean {
  const dist = resolve(ROOT, 'packages/client/dist');
  if (!existsSync(dist)) return false;
  const declared = declaredBundleFiles().map((file) => resolve(ROOT, 'packages/client', file));
  if (declared.length === 0 || declared.some((file) => !existsSync(file))) return false;
  let sourcedAt = newestModification(resolve(ROOT, 'packages/client/src'), (path) =>
    DESIGN_TEST_SOURCE.test(path),
  );
  for (const file of [...DESIGN_METADATA_FILES, 'package.json', 'package-lock.json']) {
    const path = resolve(ROOT, file);
    if (existsSync(path)) sourcedAt = Math.max(sourcedAt, statSync(path).mtimeMs);
  }
  return declared.every((file) => statSync(file).mtimeMs >= sourcedAt);
}

/**
 * The bundle paths `packages/client/package.json` promises: its entry fields and
 * every string leaf of `exports`, kept to the ones inside `dist`. These are what
 * a caller — and so the design rules, resolving `@librechat/client` — actually
 * loads, which is what makes their absence a build that did not happen rather
 * than a build that is merely old. A subpath pattern (`./dist/fonts/*`) names no
 * file a caller loads as an entry, so it is not one of them.
 */
function declaredBundleFiles(): string[] {
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(
      readFileSync(resolve(ROOT, 'packages/client/package.json'), 'utf8'),
    ) as Record<string, unknown>;
  } catch {
    return [];
  }
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

/**
 * The newest mtime under `directory`, in milliseconds; 0 when it is absent. The
 * directories count too, not only the files in them: deleting a source leaves
 * every surviving file older than the build, and the parent directory's mtime is
 * the only record that the module a stale `dist` still exports is gone.
 *
 * `skip` drops files the caller does not build from, by absolute path. It is not
 * applied to directories, for the reason above.
 */
function newestModification(directory: string, skip?: (path: string) => boolean): number {
  if (!existsSync(directory)) return 0;
  let newest = statSync(directory).mtimeMs;
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        newest = Math.max(newest, statSync(path).mtimeMs);
        walk(path);
        continue;
      }
      if (skip?.(path)) continue;
      newest = Math.max(newest, statSync(path).mtimeMs);
    }
  };
  walk(directory);
  return newest;
}

/**
 * The design rules read each primitive's `cva` variants through the
 * `@librechat/client` entry point, which resolves to `packages/client/dist`. With
 * no build present the rules cannot classify what a primitive owns and report
 * strictly fewer violations — a lint that passes for the wrong reason, and a
 * recorded baseline that disagrees with the same tree on a machine that did
 * build. Building here, rather than skipping, is the same choice the config
 * suite makes below.
 *
 * A zero exit is not the postcondition. The question `designMetadataIsFresh`
 * asks is whether `dist` describes these sources, and a build that reports
 * success while leaving the bundle incomplete or older than what it was built
 * from answers it the same way it did before — so it is asked again. Otherwise
 * the lint that follows classifies against a bundle that describes something
 * else, which is the failure this whole function exists to prevent, arrived at
 * through the branch that was supposed to fix it.
 */
function buildClientPackage(): CheckOutcome | null {
  if (designMetadataIsFresh()) return null;
  const build = runCommand(NPM, ['run', 'build:client-package']);
  if (build.status !== 0) {
    return {
      ok: false,
      output: `npm run build:client-package failed; the design rules cannot read the primitives' variants without it:\n${build.output}`,
    };
  }
  if (!designMetadataIsFresh()) {
    return {
      ok: false,
      output:
        'npm run build:client-package reported success, but packages/client/dist is still incomplete or older than the sources it is built from. The design rules would classify against a bundle that does not describe these primitives and report fewer violations than CI.',
    };
  }
  return null;
}

// --------------------------------------------------------------- config migration tests

/**
 * The config suite reaches these workspaces through their `dist` exports, so
 * CI builds them before running it. Building here too — rather than skipping
 * when `dist` is absent — keeps a fresh checkout from reporting a pass for a
 * gate that never ran, and keeps a stale `dist` from being tested instead of
 * the working tree. Each is a sub-second tsdown build.
 */
const CONFIG_TEST_BUILDS = ['build:data-provider', 'build:data-schemas', 'build:api'];

/** Dependency order; callers pass a subset and it is built in this sequence. */
const BUILD_ORDER = [
  'build:data-provider',
  'build:data-schemas',
  'build:api',
  'build:client-package',
];

/** Returns the failing build's outcome, or null when every build succeeded. */
function buildWorkspaces(scripts: string[]): CheckOutcome | null {
  for (const script of BUILD_ORDER.filter((entry) => scripts.includes(entry))) {
    const build = runCommand(NPM, ['run', script]);
    if (build.status !== 0) {
      return { ok: false, output: `npm run ${script} failed:\n${build.output}` };
    }
  }
  return null;
}

function runConfigTests(): CheckOutcome {
  const buildFailure = buildWorkspaces(CONFIG_TEST_BUILDS);
  if (buildFailure) return buildFailure;

  mkdirSync(resolve(ROOT, 'api/data'), { recursive: true });
  const authFile = resolve(ROOT, 'api/data/auth.json');
  if (!existsSync(authFile)) writeFileSync(authFile, '{}\n');

  const envFile = resolve(ROOT, 'api/test/.env.test');
  const envExample = resolve(ROOT, 'api/test/.env.test.example');
  if (!existsSync(envFile) && existsSync(envExample)) copyFileSync(envExample, envFile);

  const jest = resolveBin('jest');
  if (!jest) return missingBin('jest');

  // Same invocation as `npm run test:config`.
  const result = runCommand(jest, ['--config', 'config/jest.config.js']);
  return { ok: result.status === 0, output: result.output };
}

// --------------------------------------------------------------- unused i18n keys

const TOKEN_PATTERN = /[A-Za-z0-9_]+/g;
const CATEGORY_LOOKUP = /category\.(label|description).*startsWith.*['"]com_/;

/**
 * CI greps every key across the source dirs one key at a time. This collects
 * the identifiers once and tests keys against them, which is the same
 * substring question asked in a single pass: any occurrence of a key is inside
 * a maximal `[A-Za-z0-9_]+` run, because keys are made only of those
 * characters.
 */
async function findUnusedI18nKeys(): Promise<CheckOutcome> {
  const translationFile = resolve(ROOT, I18N_FILE);
  if (!existsSync(translationFile)) {
    return { ok: false, output: `Translation file not found: ${I18N_FILE}` };
  }

  const translations = JSON.parse(await readFile(translationFile, 'utf8')) as Record<
    string,
    string
  >;
  const keys = Object.keys(translations);
  if (keys.length === 0) return { ok: true, skipped: 'no keys defined' };

  const shortestKey = keys.reduce((shortest, key) => Math.min(shortest, key.length), Infinity);
  const tokens = new Set<string>();
  let hasCategoryLookup = false;

  for (const file of await collectFiles(I18N_SOURCE_DIRS, SOURCE_EXTENSIONS)) {
    const content = await readFile(file, 'utf8');
    if (!hasCategoryLookup) hasCategoryLookup = CATEGORY_LOOKUP.test(content);
    for (const token of content.match(TOKEN_PATTERN) ?? []) {
      if (token.length >= shortestKey) tokens.add(token);
    }
  }

  let tokenList: string[] | null = null;
  const isReferenced = (key: string): boolean => {
    if (tokens.has(key)) return true;
    tokenList ??= [...tokens];
    return tokenList.some((token) => token.includes(key));
  };

  const unused = keys.filter((key) => {
    // Special variable labels are built dynamically from TSpecialVarLabel.
    if (key.startsWith('com_ui_special_var_') && tokens.has('TSpecialVarLabel')) return false;
    // Agent category keys are read back from the database.
    if (
      key.startsWith('com_agents_category_') &&
      (hasCategoryLookup || tokens.has('ensureDefaultCategories'))
    ) {
      return false;
    }
    return !isTranslationReferenced(key, isReferenced);
  });

  if (unused.length === 0) return { ok: true };
  return {
    ok: false,
    output: `Found ${unused.length} unused i18n key(s):\n${unused.map((key) => `  ${key}`).join('\n')}`,
    hints: [`Remove them from ${I18N_FILE} or reference them in the source.`],
  };
}

// --------------------------------------------------------------- CSS colours

function checkCssColors(): CheckOutcome {
  const script = resolve(ROOT, 'scripts/css-colors.mts');
  if (!existsSync(script)) {
    return { ok: false, output: 'scripts/css-colors.mts is missing' };
  }
  const scan = runCommand({ command: process.execPath, args: [script] }, []);
  const scannerTests = runCommand(
    { command: process.execPath, args: ['--test', resolve(ROOT, 'scripts/css-colors.test.mts')] },
    [],
  );
  return {
    ok: scan.status === 0 && scannerTests.status === 0,
    output: [scan.output, scannerTests.status === 0 ? '' : scannerTests.output]
      .filter(Boolean)
      .join('\n'),
  };
}

// --------------------------------------------------------------- circular dependencies

function findCircularDependencies(): CheckOutcome {
  const script = resolve(ROOT, 'config/circular-deps.mjs');
  if (!existsSync(script)) {
    return { ok: false, output: 'config/circular-deps.mjs is missing' };
  }
  const result = runCommand({ command: process.execPath, args: [script] }, []);
  return { ok: result.status === 0, output: result.output };
}

// --------------------------------------------------------------- TypeScript

/**
 * One entry per `tsc --noEmit` the review workflows run. `paths` includes each
 * project's upstream packages, so an edit to data-provider still typechecks the
 * projects that consume it; `requires` lists the builds its imports resolve
 * through, mirroring those jobs' dependency on the build artifacts.
 */
const ROOT_MANIFESTS = ['package.json', 'package-lock.json'];

/** Each imported gate reruns in CI when its owning workflow changes. */
const BACKEND_REVIEW = '.github/workflows/backend-review.yml';
const FRONTEND_REVIEW = '.github/workflows/frontend-review.yml';

const TYPECHECK_PROJECTS = [
  {
    project: 'packages/data-provider/tsconfig.json',
    paths: ['packages/data-provider/**', ...ROOT_MANIFESTS, BACKEND_REVIEW, '!**.md'],
    requires: [],
  },
  {
    project: 'packages/data-schemas/tsconfig.json',
    paths: [
      'packages/data-provider/**',
      'packages/data-schemas/**',
      ...ROOT_MANIFESTS,
      BACKEND_REVIEW,
      '!**.md',
    ],
    requires: ['build:data-provider'],
  },
  {
    project: 'packages/api/tsconfig.json',
    paths: [
      'packages/data-provider/**',
      'packages/data-schemas/**',
      'packages/api/**',
      ...ROOT_MANIFESTS,
      BACKEND_REVIEW,
      '!**.md',
    ],
    requires: ['build:data-provider', 'build:data-schemas'],
  },
  {
    project: 'packages/client/tsconfig.json',
    paths: [
      'packages/data-provider/**',
      'packages/client/**',
      ...ROOT_MANIFESTS,
      BACKEND_REVIEW,
      '!**.md',
    ],
    requires: ['build:data-provider'],
  },
  {
    project: 'client/tsconfig.json',
    paths: [
      'client/**',
      'packages/data-provider/**',
      'packages/client/**',
      ...ROOT_MANIFESTS,
      FRONTEND_REVIEW,
      '!**.md',
    ],
    requires: ['build:data-provider', 'build:client-package'],
  },
];

function runTypecheck(context: CheckContext): CheckOutcome {
  const selected = TYPECHECK_PROJECTS.filter((entry) => groupIsActive(context.files, entry.paths));
  if (selected.length === 0) {
    return { ok: true, skipped: 'no changed TypeScript project' };
  }

  const tsc = resolveBin('typescript', 'tsc');
  if (!tsc) return missingBin('typescript');

  const buildFailure = buildWorkspaces([...new Set(selected.flatMap((entry) => entry.requires))]);
  if (buildFailure) return buildFailure;

  const failures: string[] = [];
  for (const entry of selected) {
    const result = runCommand(tsc, ['--noEmit', '-p', entry.project]);
    if (result.status !== 0) {
      failures.push(`${entry.project}:\n${result.output.trim()}`);
    }
  }

  return {
    ok: failures.length === 0,
    output: failures.join('\n\n'),
    hints: [
      'Missing properties on a workspace type usually mean a stale build: run npm run build:packages.',
      'In a git worktree, librechat-data-provider resolves to the main checkout, whose dist may predate your branch.',
    ],
  };
}

// --------------------------------------------------------------- unused npm packages

const IMPORT_PATTERNS = [
  /require\(\s*['"]([a-zA-Z0-9@/._-]+)['"]\s*\)/g,
  /\bimport\b[^\n]*?\bfrom\s*['"]([a-zA-Z0-9@/._-]+)['"]/g,
  /\bexport\b[^\n]*?\bfrom\s*['"]([a-zA-Z0-9@/._-]+)['"]/g,
  /\bimport\s*['"]([a-zA-Z0-9@/._-]+)['"]/g,
];

/** `@scope/pkg/sub` -> `@scope/pkg`, `pkg/sub` -> `pkg`, relative -> null. */
function packageName(specifier: string): string | null {
  if (specifier.startsWith('.')) return null;
  if (!specifier.startsWith('@')) return specifier.split('/')[0];
  const [scope, name] = specifier.split('/');
  return name ? `${scope}/${name}` : null;
}

async function importedPackages(dir: string): Promise<Set<string>> {
  const packages = new Set<string>();
  for (const file of await collectFiles([dir], IMPORT_EXTENSIONS)) {
    const content = await readFile(file, 'utf8');
    for (const pattern of IMPORT_PATTERNS) {
      for (const match of content.matchAll(pattern)) {
        const name = packageName(match[1]);
        if (name) packages.add(name);
      }
    }
  }
  return packages;
}

interface Manifest {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

async function readManifest(file: string): Promise<Manifest | null> {
  const path = resolve(ROOT, file);
  if (!existsSync(path)) return null;
  return JSON.parse(await readFile(path, 'utf8')) as Manifest;
}

/** Words appearing in a manifest's npm scripts, as CI extracts them. */
function scriptWords(manifest: Manifest | null): Set<string> {
  const words = new Set<string>();
  for (const script of Object.values(manifest?.scripts ?? {})) {
    for (const word of script.match(/[a-zA-Z0-9_-]+/g) ?? []) words.add(word);
  }
  return words;
}

function manifestDependencies(manifest: Manifest | null): Set<string> {
  return new Set([
    ...Object.keys(manifest?.dependencies ?? {}),
    ...Object.keys(manifest?.devDependencies ?? {}),
    ...Object.keys(manifest?.peerDependencies ?? {}),
  ]);
}

/** Dependencies a manifest inherits through its `@librechat/*` workspaces. */
async function workspaceDependencies(manifest: Manifest | null): Promise<Set<string>> {
  const inherited = new Set<string>();
  for (const dependency of Object.keys(manifest?.dependencies ?? {})) {
    if (!dependency.startsWith('@librechat/')) continue;
    const workspace = await readManifest(
      `${dependency.replace('@librechat/', 'packages/')}/package.json`,
    );
    for (const name of Object.keys(workspace?.dependencies ?? {})) inherited.add(name);
    for (const name of Object.keys(workspace?.peerDependencies ?? {})) inherited.add(name);
  }
  return inherited;
}

/** Falls back to a global install, which is how CI provides depcheck. */
function resolveDepcheck(): Executable {
  return (
    resolveBin('depcheck') ?? {
      command: 'depcheck',
      args: [],
      // A global install is `depcheck.cmd` on Windows, which needs a shell.
      shell: process.platform === 'win32',
    }
  );
}

function unusedDependencies(depcheck: Executable, cwd: string): string[] | null {
  const result = runCommand(depcheck, ['--json'], cwd);
  // depcheck exits non-zero when it reports findings, so only parse failures matter.
  try {
    const report = JSON.parse(result.stdout) as { dependencies?: string[] };
    return report.dependencies ?? [];
  } catch {
    return null;
  }
}

async function findUnusedPackages(): Promise<CheckOutcome> {
  const depcheck = resolveDepcheck();
  const probe = runCommand(depcheck, ['--version']);
  if (probe.status !== 0) {
    return { ok: true, skipped: 'depcheck is not installed — npm install -g depcheck' };
  }

  const [rootManifest, clientManifest, apiManifest, packagesClientManifest, packagesApiManifest] =
    await Promise.all([
      readManifest('package.json'),
      readManifest('client/package.json'),
      readManifest('api/package.json'),
      readManifest('packages/client/package.json'),
      readManifest('packages/api/package.json'),
    ]);

  const [rootCode, clientCode, apiCode, packagesClientCode, packagesApiCode] = await Promise.all([
    importedPackages('.'),
    importedPackages('client'),
    importedPackages('api'),
    importedPackages('packages/client'),
    importedPackages('packages/api'),
  ]);

  const targets = [
    {
      name: 'Root',
      dir: ROOT,
      allowed: [scriptWords(rootManifest), rootCode, await workspaceDependencies(rootManifest)],
      ignored: new Set<string>(),
    },
    {
      name: 'Client',
      dir: resolve(ROOT, 'client'),
      allowed: [
        scriptWords(clientManifest),
        clientCode,
        await workspaceDependencies(clientManifest),
        packagesClientCode,
        manifestDependencies(packagesClientManifest),
      ],
      // Consumed through a bundler alias, so depcheck cannot see the import.
      ignored: new Set(['micromark-extension-llm-math']),
    },
    {
      name: 'API',
      dir: resolve(ROOT, 'api'),
      allowed: [
        scriptWords(apiManifest),
        apiCode,
        await workspaceDependencies(apiManifest),
        packagesApiCode,
        manifestDependencies(packagesApiManifest),
      ],
      ignored: new Set<string>(),
    },
  ];

  const findings: string[] = [];
  for (const target of targets) {
    if (!existsSync(join(target.dir, 'package.json'))) continue;
    const unused = unusedDependencies(depcheck, target.dir);
    if (unused === null) {
      return { ok: false, output: `depcheck produced no JSON report for ${target.name}` };
    }
    const reportable = unused.filter(
      (name) => !target.ignored.has(name) && !target.allowed.some((set) => set.has(name)),
    );
    if (reportable.length > 0) {
      findings.push(
        `${target.name} unused dependencies:\n${reportable.map((n) => `  ${n}`).join('\n')}`,
      );
    }
  }

  return {
    ok: findings.length === 0,
    output: findings.join('\n'),
    // CI scans node_modules too, so it treats a few more packages as used.
    hints: [
      'CI also counts imports found under node_modules — confirm before removing a dependency.',
    ],
  };
}

// --------------------------------------------------------------- runner

const CHECKS: Check[] = [
  { id: 'eslint', title: 'ESLint', tier: 'fast', group: 'eslint', run: lintChangedFiles },
  { id: 'prettier', title: 'Prettier', tier: 'fast', group: 'eslint', run: checkFormatting },
  { id: 'imports', title: 'Import sorting', tier: 'fast', group: 'eslint', run: checkImportOrder },
  {
    id: 'eslint-config',
    title: 'ESLint config validation',
    tier: 'fast',
    group: 'eslint_config',
    run: validateEslintConfig,
  },
  {
    id: 'json',
    title: 'package.json validation',
    tier: 'fast',
    group: 'unused_packages',
    run: validatePackageJson,
  },
  {
    id: 'suppressions',
    title: 'Design-rule suppressions',
    tier: 'fast',
    group: 'suppressions',
    run: validateSuppressions,
  },
  {
    id: 'css-colors',
    title: 'CSS colour literals',
    tier: 'fast',
    group: 'css_colors',
    run: checkCssColors,
  },
  {
    id: 'circular-deps',
    title: 'Circular dependencies',
    tier: 'fast',
    group: 'circular_deps',
    run: findCircularDependencies,
  },
  {
    id: 'typecheck',
    title: 'TypeScript',
    tier: 'slow',
    group: 'typecheck',
    run: runTypecheck,
  },
  {
    id: 'config-tests',
    title: 'Config migration tests',
    tier: 'slow',
    group: 'config',
    run: runConfigTests,
  },
  { id: 'i18n', title: 'Unused i18n keys', tier: 'slow', group: 'i18n', run: findUnusedI18nKeys },
  {
    id: 'depcheck',
    title: 'Unused npm packages',
    tier: 'slow',
    group: 'unused_packages',
    run: findUnusedPackages,
  },
];

const TITLE_WIDTH = 26;

function report(symbol: string, title: string, detail: string): void {
  console.log(`  ${symbol} ${title.padEnd(TITLE_WIDTH)} ${detail}`);
}

function printBlock(text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  console.log(
    trimmed
      .split('\n')
      .map((line) => `      ${line}`)
      .join('\n'),
  );
}

async function main(): Promise<void> {
  const unknown = [...OPTIONS.only, ...OPTIONS.skip].filter(
    (id) => !CHECKS.some((check) => check.id === id),
  );
  if (unknown.length > 0) fail(`unknown check id(s): ${unknown.join(', ')}`);

  const target = resolveTarget();
  const groups = Object.fromEntries(
    Object.entries(FILTERS).map(([name, patterns]) => [
      name,
      groupIsActive(target.files, patterns),
    ]),
  ) as Record<FilterName, boolean>;

  const context: CheckContext = {
    files: target.files,
    groups,
    sourceFiles: target.existing
      .filter((file) => SOURCE_FILE_PATTERN.test(file))
      .filter((file) => existsSync(resolve(ROOT, file))),
  };

  const selected = CHECKS.filter(
    (check) => OPTIONS.only.length === 0 || OPTIONS.only.includes(check.id),
  );

  if (OPTIONS.list) {
    console.log(`Static checks · ${target.label} · ${target.files.length} file(s)`);
    for (const check of CHECKS) {
      const state = !selected.includes(check)
        ? 'deselected'
        : OPTIONS.skip.includes(check.id)
          ? 'skipped (--skip)'
          : !groups[check.group]
            ? 'not affected'
            : check.tier === 'slow' && !OPTIONS.full && !OPTIONS.only.includes(check.id)
              ? 'slow tier (--full)'
              : 'would run';
      report(' ', `${check.title} (${check.id})`, state);
    }
    return;
  }

  console.log(`Static checks · ${target.label} · ${target.files.length} file(s)`);
  if (target.files.length === 0) {
    console.log('\nNothing to check.');
    return;
  }

  const failures: string[] = [];
  let skipped = 0;

  for (const check of selected) {
    if (OPTIONS.skip.includes(check.id)) {
      skipped++;
      report('–', check.title, 'skipped (--skip)');
      continue;
    }
    if (!groups[check.group]) {
      report('–', check.title, 'not affected by this diff');
      continue;
    }
    if (check.tier === 'slow' && !OPTIONS.full && !OPTIONS.only.includes(check.id)) {
      skipped++;
      report('–', check.title, 'skipped (run with --full)');
      continue;
    }

    const started = Date.now();
    // The CI job gives every step continue-on-error; a check that throws
    // (malformed translation JSON, say) must not cancel the ones after it.
    let outcome: CheckOutcome;
    try {
      outcome = await check.run(context);
    } catch (error) {
      outcome = { ok: false, output: `${check.title} threw: ${(error as Error).stack ?? error}` };
    }
    const elapsed = `${((Date.now() - started) / 1000).toFixed(1)}s`;

    if (outcome.skipped) {
      skipped++;
      report('–', check.title, `skipped: ${outcome.skipped}`);
      continue;
    }
    if (outcome.ok) {
      report('✓', check.title, elapsed);
      if (OPTIONS.verbose) printBlock(outcome.output ?? '');
      continue;
    }

    failures.push(check.title);
    report('✗', check.title, elapsed);
    printBlock(outcome.output ?? '');
    for (const hint of outcome.hints ?? []) printBlock(hint);
  }

  const tail = skipped > 0 ? ` (${skipped} skipped)` : '';
  if (failures.length === 0) {
    console.log(`\nAll affected static checks passed${tail}.`);
    return;
  }

  console.log(`\nStatic checks failed:\n${failures.map((title) => `  - ${title}`).join('\n')}`);
  process.exitCode = 1;
}

await main();
