import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { strict as assert } from 'node:assert';
import { Instrumenter } from '@stryker-mutator/instrumenter';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';

import {
  cognitiveFunctions,
  mutationTarget,
  selectedFunctions,
  riskReport,
  riskMarkdown,
} from './risk.mts';
import { changedRanges, isSource, overlaps, workspaceFor, WORKSPACES } from './changes.mts';
import { measureFunctions } from '../crap.mts';
import { coverageGroups, runCoverage } from './jest.mts';

test('every application workspace has a source owner; test/support/declaration files are excluded', () => {
  for (const workspace of WORKSPACES) {
    const file = `${workspace.path}/src/feature.ts`;
    assert.equal(workspaceFor(file)?.name, workspace.name);
    assert.equal(isSource(file), true);
  }
  for (const file of [
    'a.test.ts',
    'a.spec.tsx',
    'a.d.ts',
    'a.helper.ts',
    'a.manual.ts',
    'api/test/util.js',
    'client/src/__tests__/util.ts',
    'packages/chat/test/entry.ts',
    'packages/api/src/__mocks__/x.js',
    'packages/data-schemas/misc/test.ts',
  ]) {
    assert.equal(isSource(file), false, file);
  }
  assert.equal(workspaceFor('scripts/something.mts'), undefined);
});

test('diff ranges handle additions, replacements and deletion-only edits without selecting a neighbour', () => {
  const ranges = changedRanges(
    '@@ -3,2 +3,0 @@\n-x\n-y\n@@ -9 +7,2 @@\n+x\n+y\n@@ -20,0 +19 @@\n+z',
  );
  assert.deepEqual(ranges, [
    { start: 3, count: 0 },
    { start: 7, count: 2 },
    { start: 19, count: 1 },
  ]);
  assert.equal(overlaps(2, 6, ranges), true);
  assert.equal(overlaps(4, 6, ranges), false);
  assert.equal(overlaps(1, 3, ranges), false);
  assert.equal(overlaps(8, 12, ranges), true);
  assert.equal(overlaps(13, 18, ranges), false);
});

test('SonarJS reports zero, nesting, callbacks and methods at their own locations', () => {
  const source = `function straight() { return 1; }
function outer(a: boolean, b: boolean) {
  const inner = () => { if (a) return 2; return 0; };
  if (a) { if (b) return inner(); }
  return 0;
}
class Box { method(a: boolean) { return a ? 1 : 0; } }
const obj = { check(a: boolean) { if (a) return 1; return 0; } };`;
  const scores = cognitiveFunctions('sample.ts', source);
  assert.deepEqual(
    scores.map((fn) => fn.cognitiveComplexity),
    [0, 3, 1, 1, 1],
  );
  const classic = measureFunctions(resolve('sample.ts'), source);
  assert.deepEqual(
    scores.map(({ line, column }) => [line, column]),
    classic.map(({ line, column }) => [line, column]),
  );
});

test('JSX, async arrows, getters and anonymous route callbacks are measured', () => {
  const source = `const View = ({ ok }) => ok ? <span /> : null;
const work = async (ok) => { if (ok) return 1; return 0; };
class Box { get value() { if (ready) return 1; return 0; } }
app.get('/x', function(req, res) { if (req.ok) res.send('ok'); });`;
  assert.deepEqual(
    cognitiveFunctions('sample.tsx', source).map((fn) => fn.cognitiveComplexity),
    [1, 1, 1, 1],
  );
  assert.equal(measureFunctions(resolve('sample.tsx'), source).length, 4);
});

test('inline disable comments do not hide scores and invalid syntax fails', () => {
  assert.equal(
    cognitiveFunctions(
      'sample.ts',
      '/* eslint sonarjs/cognitive-complexity: off */\nfunction f(a) { if (a) return 1; }',
    )[0].cognitiveComplexity,
    1,
  );
  assert.throws(() => cognitiveFunctions('sample.ts', 'function {'), /Parsing error/);
});

test('computed property callbacks keep their own cognitive score', () => {
  const source =
    "const obj = { [(() => a ? (b ? 'x' : 'y') : 'z')()]() { if (ok) return 1; return 0; } };";
  assert.deepEqual(
    cognitiveFunctions('sample.ts', source).map((fn) => fn.cognitiveComplexity),
    [3, 1],
  );
});

test('only edited nested functions are selected; unchanged parents and siblings stay out', () => {
  const before = `function factory() {
  const untouched = () => true;
  const edited = () => false;
  return { untouched, edited };
}`;
  const after = before.replace('() => false', '() => true');
  assert.deepEqual(
    selectedFunctions('sample.ts', after, [{ start: 3, count: 1 }], before)
      .filter((fn) => fn.selected)
      .map((fn) => fn.line),
    [3],
  );
  assert.equal(
    selectedFunctions(
      'sample.ts',
      before.replace('return {', '// comment\n  return {'),
      [{ start: 4, count: 2 }],
      before,
    ).filter((fn) => fn.selected).length,
    0,
  );
});

test('function selection handles deletion-only edits, duplicate additions, renames and moved functions', () => {
  const before = 'function f() {\n if (ready) return true;\n return false;\n}';
  const after = 'function f() {\n return false;\n}';
  assert.equal(
    selectedFunctions('sample.ts', after, [{ start: 1, count: 0 }], before)[0].selected,
    true,
  );
  const duplicate = 'const f = () => true;\n';
  assert.deepEqual(
    selectedFunctions('sample.ts', duplicate + duplicate, [{ start: 1, count: 1 }], duplicate)
      .filter((fn) => fn.selected)
      .map((fn) => fn.line),
    [1],
  );
  assert.equal(
    selectedFunctions(
      'sample.ts',
      before.replace('f()', 'renamed()'),
      [{ start: 1, count: 1 }],
      before,
    )[0].selected,
    true,
  );
  assert.equal(
    selectedFunctions('sample.ts', '\n' + before, [{ start: 1, count: 1 }], before)[0].selected,
    false,
  );
});

test('real Stryker instrumentation excludes module-level code and unchanged nested bodies', async () => {
  const before = `const STATIC = true;
function factory() {
  const untouched = () => true;
  const edited = () => false;
  return { untouched, edited, enabled: false };
}`;
  const source = before
    .replace('() => false', '() => true')
    .replace('enabled: false', 'enabled: true');
  const target = mutationTarget('fixture.ts', source, [{ start: 4, count: 2 }], before);
  assert.equal(target.functions.length, 2);
  const ranges = target.mutate.map((pattern) => {
    const match = /:(\d+):(\d+)-(\d+):(\d+)$/u.exec(pattern);
    assert.ok(match);
    return {
      start: { line: Number(match[1]) - 1, column: Number(match[2]) },
      end: { line: Number(match[3]) - 1, column: Number(match[4]) },
    };
  });
  const disabled = () => false;
  const silent = () => {};
  const instrumenter = new Instrumenter({
    isTraceEnabled: disabled,
    isDebugEnabled: disabled,
    isInfoEnabled: disabled,
    isWarnEnabled: disabled,
    isErrorEnabled: disabled,
    isFatalEnabled: disabled,
    trace: silent,
    debug: silent,
    info: silent,
    warn: silent,
    error: silent,
    fatal: silent,
  });
  const result = await instrumenter.instrument(
    [{ name: resolve('fixture.ts'), content: source, mutate: ranges }],
    { plugins: null, ignorers: [], excludedMutations: [] },
  );
  assert.ok(result.mutants.some((mutant) => mutant.location.start.line === 3));
  assert.ok(result.mutants.some((mutant) => mutant.location.start.line === 4));
  assert.ok(
    result.mutants.every(
      (mutant) => mutant.location.start.line >= 3 && mutant.location.end.line <= 4,
    ),
  );
});

test('real Jest groups reuse compiled code, isolate Redis settings and preserve reports', (t) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'quality-jest-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const require = createRequire(import.meta.url);
  const files = ['first.js', 'second[part].js'];
  for (const file of [...files, 'untouched.js', 'secondp.js']) {
    writeFileSync(join(directory, file), 'module.exports = () => 1;');
  }
  const transforms = join(directory, 'transforms.jsonl');
  writeFileSync(
    join(directory, 'transform.cjs'),
    `const fs = require('node:fs');
module.exports = { process(code, filename, options) {
  fs.appendFileSync(${JSON.stringify(transforms)}, JSON.stringify({ filename, instrument: options.instrument }) + '\\n');
  return { code };
} };`,
  );
  writeFileSync(
    join(directory, 'jest.config.json'),
    JSON.stringify({
      rootDir: directory,
      maxWorkers: 2,
      workerIdleMemoryLimit: '1GB',
      cacheDirectory: join(directory, 'cache'),
      transform: { '^.+\\.js$': join(directory, 'transform.cjs') },
    }),
  );
  writeFileSync(
    join(directory, 'sample.test.js'),
    "test('unit source', () => { expect(process.env.USE_REDIS).toBe('false'); expect(require('./first')()).toBe(1); expect(require('./untouched')()).toBe(1); expect(require('./secondp')()).toBe(1); });",
  );
  writeFileSync(
    join(directory, 'sample.cache_integration.spec.js'),
    "test('Redis source', () => { expect(process.env.USE_REDIS).toBe('true'); expect(process.env.USE_REDIS_CLUSTER).toBe('false'); expect(require('./second[part]')()).toBe(1); });",
  );
  const output = join(directory, 'coverage');
  const options = {
    workspace: 'api',
    config: 'jest.config.json',
    cwd: directory,
    jestBin: require.resolve('jest/bin/jest'),
    files,
    tests: ['sample.test.js', 'sample.cache_integration.spec.js'],
    output,
    env: { ...process.env, NODE_ENV: 'test', USE_REDIS: 'false' },
  };
  runCoverage(options);
  const coverage = JSON.parse(readFileSync(join(output, 'coverage-final.json'), 'utf8'));
  assert.deepEqual(
    Object.keys(coverage).sort(),
    files.map((file) => join(directory, file)),
  );
  for (const file of files)
    assert.ok(Object.values(coverage[join(directory, file)].f).every((hits) => Number(hits) > 0));
  const compiled: { filename: string; instrument: boolean }[] = readFileSync(transforms, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  for (const file of files) {
    assert.equal(
      compiled.filter((entry) => entry.filename === join(directory, file) && entry.instrument)
        .length,
      1,
      `${file} should be compiled once across coverage groups`,
    );
  }
  for (const group of ['unit', 'cache-core']) {
    const results = JSON.parse(readFileSync(join(output, group, 'tests.json'), 'utf8'));
    assert.equal(results.numPassedTests, 1);
    assert.ok(existsSync(join(output, group, 'coverage-final.json')));
  }
  writeFileSync(
    join(directory, 'sample.cache_integration.spec.js'),
    "test('failure is preserved', () => expect(1).toBe(2));",
  );
  writeFileSync(join(directory, 'sample.stream_integration.spec.js'), "test('later', () => {});");
  const failedOutput = join(directory, 'failed');
  assert.throws(
    () =>
      runCoverage({
        ...options,
        output: failedOutput,
        tests: [...options.tests, 'sample.stream_integration.spec.js'],
      }),
    /Jest cache-core exited with 1/u,
  );
  const failed = JSON.parse(readFileSync(join(failedOutput, 'cache-core', 'tests.json'), 'utf8'));
  assert.equal(failed.numFailedTests, 1);
  assert.ok(existsSync(join(failedOutput, 'unit', 'coverage-final.json')));
  assert.ok(existsSync(join(failedOutput, 'cache-core', 'coverage-final.json')));
  assert.equal(existsSync(join(failedOutput, 'coverage-final.json')), false);
  assert.equal(existsSync(join(failedOutput, 'cache-stream')), false);
});

test('risk report keeps only changed functions, joins real coverage, and preserves missing coverage', (t) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'quality-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'source.ts');
  const source =
    'function untouched() { return 0; }\nfunction edited(a) { if (a) return 1; return 2; }\nconst missing =\n  () => 3;';
  writeFileSync(file, source);
  const coverage = join(directory, 'coverage.json');
  const position = (offset: number) => {
    const lines = source.slice(0, offset).split('\n');
    return { line: lines.length, column: lines.at(-1)!.length };
  };
  const statement = 'return 1;';
  const start = source.indexOf(statement);
  writeFileSync(
    coverage,
    JSON.stringify({
      [file]: {
        path: file,
        statementMap: { '0': { start: position(start), end: position(start + statement.length) } },
        s: { '0': 0 },
      },
    }),
  );
  const report = riskReport(coverage, [{ file, ranges: [{ start: 2, count: 2 }] }]);
  assert.deepEqual(
    report.functions.map(({ function: name }) => name),
    ['edited', 'missing'],
  );
  assert.equal(report.functions[0].crap, 6);
  assert.equal(report.functions[0].statementCoverage, 0);
  assert.equal(report.functions[0].cognitiveComplexity, 1);
  assert.equal(report.functions[1].crap, null);
  assert.match(riskMarkdown(report), /N\/A/);
  assert.equal(riskReport(coverage, [{ file, ranges: [] }]).functions.length, 0);
});

test('every related test belongs to one coverage group with the existing cache lane ordering', () => {
  const tests = [
    '/repo/src/unit.spec.ts',
    '/repo/src/cache/one.cache_integration.spec.ts',
    '/repo/src/middleware/two.cache_integration.test.ts',
    '/repo/src/cluster/three.cache_integration.spec.ts',
    '/repo/src/mcp/four.cache_integration.spec.ts',
    '/repo/src/stream/five.stream_integration.spec.ts',
  ];
  const groups = coverageGroups('api', tests);
  assert.deepEqual(
    groups.flatMap((group) => group.tests),
    tests,
  );
  assert.deepEqual(
    groups.map(({ name, redis, serial }) => ({ name, redis, serial })),
    [
      { name: 'unit', redis: false, serial: false },
      { name: 'cache-core', redis: true, serial: false },
      { name: 'cache-cluster', redis: true, serial: true },
      { name: 'cache-mcp', redis: true, serial: false },
      { name: 'cache-stream', redis: true, serial: true },
    ],
  );
  for (const workspace of ['server', 'data-schemas']) {
    const [group] = coverageGroups(workspace, tests);
    assert.deepEqual(group.tests, tests);
    assert.equal(group.redis, false);
  }
});
