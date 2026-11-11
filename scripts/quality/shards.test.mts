import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';

import type { ShardResult, MutationReport } from './merge.mts';
import type { ShardPlan } from './shards.mts';

import { mergeReports, mutationSummary } from './merge.mts';
import { assertMutants, mutantKey } from './shards.mts';

test('four real Stryker runs preserve the unsharded mutant set, including nested and static code', () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'quality-shards-')));
  const source = `function factory() {
  function positive(value) { return value > 0; }
  return { positive, enabled: true };
}
function negative(value) { return value < 0; }
function zero(value) { return value === 0; }
function untouched() { return false; }
module.exports = { ...factory(), negative, zero, untouched };\n`;
  writeFileSync(join(directory, 'subject[one].js'), source);
  writeFileSync(join(directory, 'package-lock.json'), '{}');
  writeFileSync(
    join(directory, 'test.cjs'),
    `const assert = require('node:assert/strict');
const subject = require('./subject[one].js');
assert.equal(subject.positive(1), true);
assert.equal(subject.positive(0), false);
assert.equal(subject.negative(-1), true);
assert.equal(subject.zero(0), true);
assert.equal(subject.enabled, true);\n`,
  );
  const script = `import { Stryker } from ${JSON.stringify(import.meta.resolve('@stryker-mutator/core'))};
import { mutationTarget } from ${JSON.stringify(new URL('./risk.mts', import.meta.url).href)};
import { planShards, mutantKey, assertMutants, mutationPatterns } from ${JSON.stringify(new URL('./shards.mts', import.meta.url).href)};
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const source = readFileSync('subject[one].js', 'utf8');
const target = mutationTarget('subject[one].js', source, [{start: 1, count: 6}], source.replace('> 0', '> 1').replace('enabled: true', 'enabled: false').replace('< 0', '< 1').replace('=== 0', '=== 1'));
const plan = await planShards([target], 'base', 'head', 'fixture');
writeFileSync('plan.json', JSON.stringify(plan));
for (const index of [0,1,2,3,4]) {
  const shard = plan.shards[index - 1];
  const targets = shard?.targets ?? [target];
  const output = 'report-' + index;
  mkdirSync(output);
  writeFileSync(output + '/functions.json', JSON.stringify(targets));
  if (shard?.expected.length === 0) continue;
  const results = await new Stryker({
    plugins: [${JSON.stringify(new URL('./progress.mts', import.meta.url).href)}],
    testRunner: 'command', commandRunner: { command: ${JSON.stringify(JSON.stringify(process.execPath) + ' test.cjs')} },
    ignorePatterns: ['**', '!subject[[]one].js', '!test.cjs'],
    mutate: mutationPatterns(targets), reporters: ['function-progress', 'json'],
    jsonReporter: {fileName: output + '/mutation.json'},
    coverageAnalysis: 'off', concurrency: 1, timeoutMS: 1000, thresholds: {break: 0},
  }).runMutationTest();
  if (shard) assertMutants(shard.expected, results.map(m => mutantKey('subject[one].js', m)));
}`;
  writeFileSync(join(directory, 'run.mjs'), script);
  try {
    const run = spawnSync(process.execPath, ['run.mjs'], {
      cwd: directory,
      encoding: 'utf8',
      timeout: 120000,
    });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const plan: ShardPlan = JSON.parse(readFileSync(join(directory, 'plan.json'), 'utf8'));
    const baseline: MutationReport = JSON.parse(
      readFileSync(join(directory, 'report-0/mutation.json'), 'utf8'),
    );
    const results: ShardResult[] = plan.shards.map((shard) => ({
      plan,
      completion: {
        digest: plan.digest,
        index: shard.index,
        complete: true,
        total: shard.expected.length,
      },
      report: shard.expected.length
        ? JSON.parse(readFileSync(join(directory, `report-${shard.index}/mutation.json`), 'utf8'))
        : undefined,
    }));
    const merged = mergeReports(results);
    const keys = (report: MutationReport) =>
      Object.entries(report.files).flatMap(([file, value]) =>
        value.mutants.map((mutant) =>
          mutantKey(file, { ...mutant, replacement: mutant.replacement! }),
        ),
      );
    assertMutants(keys(baseline), keys(merged));
    assert.ok(keys(merged).length > 5);
    assert.ok(plan.shards.filter((shard) => shard.expected.length > 0).length >= 3);
    assert.ok(
      Object.values(merged.files)
        .flatMap((file) => file.mutants)
        .every((mutant) => mutant.location.end.line <= 6),
    );
    for (const shard of plan.shards.filter((item) => item.expected.length)) {
      const progress = JSON.parse(
        readFileSync(join(directory, `report-${shard.index}/progress.json`), 'utf8'),
      );
      assert.equal(progress.complete, true);
      assert.equal(progress.total, shard.expected.length);
    }
    assert.throws(() => mergeReports(results.slice(1)), /four shards/);
    const changed = structuredClone(results);
    changed[0].plan = { ...changed[0].plan, head: 'wrong-head' };
    assert.throws(() => mergeReports(changed), /mismatched shard/);
    const mixedModes = structuredClone(results);
    mixedModes[0].plan = { ...mixedModes[0].plan, staticMutants: false };
    assert.throws(() => mergeReports(mixedModes), /mismatched shard/);
    const missing = structuredClone(results);
    missing[0].completion.complete = false;
    assert.throws(() => mergeReports(missing), /incomplete/);
    assert.throws(
      () => mergeReports([results[0], results[0], results[2], results[3]]),
      /duplicate/,
    );
    const incomplete = structuredClone(results);
    Object.values(incomplete[0].report!.files)[0].mutants.pop();
    assert.throws(() => mergeReports(incomplete), /Mutation set differs/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('combined scores use mutant counts and reject duplicates', () => {
  const result = (id: string, status: 'Killed' | 'Survived') => ({
    id,
    status,
    mutatorName: 'BooleanLiteral',
    replacement: 'false',
    location: { start: { line: 1, column: 1 }, end: { line: 1, column: 5 } },
  });
  const report: MutationReport = {
    schemaVersion: '2',
    thresholds: { high: 90, low: 70 },
    files: {
      'a.js': { source: 'true', language: 'javascript', mutants: [result('1', 'Killed')] },
      'b.js': {
        source: 'true',
        language: 'javascript',
        mutants: Array.from({ length: 9 }, (_, i) => result(String(i + 2), 'Survived')),
      },
    },
  };
  assert.match(mutationSummary(report, 'fixture'), /10.00%/);
  report.files['a.js'].mutants.push({
    ...result('ignored', 'Killed'),
    status: 'Ignored',
    static: true,
  });
  assert.match(mutationSummary(report, 'fixture', false), /10.00%/);
  assert.match(mutationSummary(report, 'fixture', false), /Static=off/);
  assert.match(mutationSummary(report, 'fixture', false), /Ignored \| 1/);
  assert.throws(() => assertMutants(['a', 'b'], ['a', 'a']), /duplicate/);
  assert.throws(() => assertMutants(['a'], ['b']), /unexpected/);
});

test('merging namespaces test references and refuses unfinished or conflicting source reports', () => {
  const reports: MutationReport[] = [1, 2, 3, 4].map((line) => ({
    schemaVersion: '1.0',
    thresholds: { high: 90, low: 70 },
    files: {
      'shared.js': {
        source: 'shared source',
        language: 'javascript',
        mutants: [
          {
            id: '0',
            status: 'Killed',
            replacement: 'false',
            mutatorName: 'BooleanLiteral',
            location: { start: { line, column: 1 }, end: { line, column: 5 } },
            coveredBy: ['0'],
            killedBy: ['0'],
          },
        ],
      },
    },
    testFiles: { 'test.js': { source: 'shared test', tests: [{ id: '0', name: 'test' }] } },
  }));
  const plan: ShardPlan = {
    base: 'base',
    head: 'head',
    workspace: 'fixture',
    digest: 'digest',
    staticMutants: true,
    shards: reports.map((report, index) => ({
      index: index + 1,
      targets: [],
      expected: [
        mutantKey('shared.js', { ...report.files['shared.js'].mutants[0], replacement: 'false' }),
      ],
    })),
  };
  const results = reports.map(
    (report, index): ShardResult => ({
      plan,
      report,
      completion: { digest: plan.digest, index: index + 1, complete: true, total: 1 },
    }),
  );
  const merged = mergeReports(results);
  assert.deepEqual(
    merged.testFiles!['test.js'].tests.map(({ id }) => id),
    ['1:0', '2:0', '3:0', '4:0'],
  );
  assert.deepEqual(
    merged.files['shared.js'].mutants.map(({ killedBy }) => killedBy),
    [['1:0'], ['2:0'], ['3:0'], ['4:0']],
  );
  assert.equal(reports[0].files['shared.js'].mutants[0].id, '0');
  for (const status of ['Pending', 'RuntimeError', 'Unknown', undefined, null, 0, {}]) {
    const unfinished = structuredClone(results);
    Reflect.set(unfinished[0].report!.files['shared.js'].mutants[0], 'status', status);
    assert.throws(() => mergeReports(unfinished), /Incomplete/);
  }
  const absent = structuredClone(results);
  Reflect.deleteProperty(absent[0].report!.files['shared.js'].mutants[0], 'status');
  assert.throws(() => mergeReports(absent), /Incomplete/);
  for (const status of ['Killed', 'Survived', 'Timeout', 'NoCoverage', 'CompileError', 'Ignored']) {
    const complete = structuredClone(results);
    Reflect.set(complete[0].report!.files['shared.js'].mutants[0], 'status', status);
    assert.equal(mergeReports(complete).files['shared.js'].mutants[0].status, status);
  }
  const changed = structuredClone(results);
  changed[1].report!.files['shared.js'].source = 'other source';
  assert.throws(() => mergeReports(changed), /Mismatched source/);
  const emptyPlan: ShardPlan = {
    ...plan,
    shards: plan.shards.map((s) => ({ ...s, expected: [] })),
  };
  const empty = mergeReports(
    emptyPlan.shards.map((s) => ({
      plan: emptyPlan,
      completion: { digest: plan.digest, index: s.index, complete: true, total: 0 },
    })),
  );
  assert.match(mutationSummary(empty, 'fixture'), /N\/A/);
});
