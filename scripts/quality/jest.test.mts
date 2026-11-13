import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { strict as assert } from 'node:assert';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';

import { resolveAliasBudgetMinutes, runAliasCoverage } from './jest.mts';

type DefaultResolver = (request: string, options: { basedir: string }) => string;
type SourceResolver = ((
  request: string,
  options: { basedir: string; defaultResolver: DefaultResolver },
) => string) & { mirrorDir: (root: string) => string };
const resolveSource = createRequire(import.meta.url)(
  './jest.source.resolver.cjs',
) as SourceResolver;

test('resolveAliasBudgetMinutes defaults, accepts the valid range, and rejects everything else', () => {
  assert.equal(resolveAliasBudgetMinutes(undefined), 20);
  assert.equal(resolveAliasBudgetMinutes(''), 20);
  assert.equal(resolveAliasBudgetMinutes('1'), 1);
  assert.equal(resolveAliasBudgetMinutes('25'), 25);
  for (const invalid of ['0', '26', '-5', '12.5', 'abc']) {
    assert.throws(
      () => resolveAliasBudgetMinutes(invalid),
      /QUALITY_ALIAS_BUDGET_MINUTES must be an integer from 1 to 25/u,
      `expected ${JSON.stringify(invalid)} to be rejected`,
    );
  }
});

function fixture(directory: string, body: string): string {
  const script = join(directory, 'fixture-jest.cjs');
  writeFileSync(script, body);
  return script;
}

test('a completed alias pass returns the parsed results and coverage', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'quality-alias-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const output = join(directory, 'out');
  const jestBin = fixture(
    directory,
    `const fs = require('node:fs');
     fs.mkdirSync(${JSON.stringify(output)}, { recursive: true });
     fs.writeFileSync(${JSON.stringify(join(output, 'tests.json'))}, JSON.stringify({ testResults: [] }));
     fs.writeFileSync(${JSON.stringify(join(output, 'coverage-final.json'))}, JSON.stringify({ '/f.ts': { hash: 'x' } }));`,
  );
  const outcome = await runAliasCoverage({
    config: 'jest.config.js',
    cwd: directory,
    jestBin,
    tests: [],
    collectFrom: [],
    output,
    env: process.env,
    budgetMinutes: 1,
  });
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.ok && outcome.value.coverage, { '/f.ts': { hash: 'x' } });
});

test('a pass that exceeds its budget is killed and reported as a timeout, not thrown', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'quality-alias-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const output = join(directory, 'out');
  // Never writes a results file; the parent must kill it instead of waiting forever.
  const jestBin = fixture(directory, 'setInterval(() => {}, 1000);');
  const outcome = await runAliasCoverage({
    config: 'jest.config.js',
    cwd: directory,
    jestBin,
    tests: [],
    collectFrom: [],
    output,
    env: process.env,
    budgetMinutes: 0.001,
  });
  assert.equal(outcome.ok, false);
  assert.equal(!outcome.ok && outcome.error.code, 'timeout');
  assert.match(!outcome.ok ? outcome.error.message : '', /exceeded 0\.001 min budget/u);
});

test('a crashing pass with no results file is reported as a failure, not thrown', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'quality-alias-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const output = join(directory, 'out');
  const jestBin = fixture(directory, 'process.exitCode = 1;');
  const outcome = await runAliasCoverage({
    config: 'jest.config.js',
    cwd: directory,
    jestBin,
    tests: [],
    collectFrom: [],
    output,
    env: process.env,
    budgetMinutes: 1,
  });
  assert.equal(outcome.ok, false);
  assert.equal(!outcome.ok && outcome.error.code, 'crashed');
  assert.match(!outcome.ok ? outcome.error.message : '', /crashed:/u);
});

test('a clean exit that still produces no results file is reported as a failure, not thrown', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'quality-alias-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const output = join(directory, 'out');
  mkdirSync(output, { recursive: true });
  const jestBin = fixture(directory, '');
  const outcome = await runAliasCoverage({
    config: 'jest.config.js',
    cwd: directory,
    jestBin,
    tests: [],
    collectFrom: [],
    output,
    env: process.env,
    budgetMinutes: 1,
  });
  assert.equal(outcome.ok, false);
  assert.equal(!outcome.ok && outcome.error.code, 'crashed');
  assert.equal(existsSync(join(output, 'tests.json')), false);
});

test('the alias pass collects mirror coverage for packages/api/src files and removes the mirror', async (t) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'quality-alias-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const output = join(directory, 'out');
  const mirror = resolveSource.mirrorDir(directory);
  const jestBin = fixture(
    directory,
    `const fs = require('node:fs');
     const path = require('node:path');
     fs.mkdirSync(path.dirname(${JSON.stringify(mirror)}), { recursive: true });
     fs.symlinkSync(${JSON.stringify(join(directory, 'packages/api/src'))}, ${JSON.stringify(mirror)});
     fs.mkdirSync(${JSON.stringify(output)}, { recursive: true });
     fs.writeFileSync(${JSON.stringify(join(output, 'argv.json'))}, JSON.stringify(process.argv));
     fs.writeFileSync(${JSON.stringify(join(output, 'tests.json'))}, JSON.stringify({ testResults: [] }));`,
  );
  const outcome = await runAliasCoverage({
    config: 'jest.config.js',
    cwd: directory,
    jestBin,
    tests: [],
    collectFrom: ['packages/api/src/a.ts', 'api/b.js'],
    output,
    env: process.env,
    budgetMinutes: 1,
  });
  assert.equal(outcome.ok, true);
  const argv: string[] = JSON.parse(readFileSync(join(output, 'argv.json'), 'utf8'));
  const collect: unknown = JSON.parse(argv[argv.indexOf('--collectCoverageFrom') + 1]);
  assert.deepEqual(collect, [
    'packages/api/src/a.ts',
    'api/b.js',
    'coverage/source-alias/src/a.ts',
  ]);
  assert.equal(existsSync(mirror), false);
});

test('the source resolver keeps api/ relative imports of packages/api/src in the mirror', () => {
  const root = process.cwd();
  const src = join(root, 'packages/api/src');
  const api = join(root, 'api');
  const mirror = resolveSource.mirrorDir(root);
  const defaultResolver: DefaultResolver = (request, options) =>
    request.startsWith('/') ? request : resolve(options.basedir, request);
  const run = (request: string, basedir: string) =>
    resolveSource(request, { basedir, defaultResolver });
  assert.equal(run('../packages/api/src/a', api), join(mirror, 'a'));
  assert.equal(run('./b', join(mirror, 'x')), join(mirror, 'x/b'));
  assert.equal(run('~/c', join(mirror, 'x')), join(mirror, 'c'));
  assert.equal(run('./b', join(src, 'x')), join(src, 'x/b'));
  assert.equal(run('~/c', join(src, 'x')), join(src, 'c'));
  assert.equal(run('~/c', api), join(api, 'c'));
  assert.equal(run(join(src, 'index.ts'), api), join(src, 'index.ts'));
  process.argv.push('--listTests');
  try {
    assert.equal(run('../packages/api/src/a', api), join(src, 'a'));
  } finally {
    process.argv.pop();
  }
});
