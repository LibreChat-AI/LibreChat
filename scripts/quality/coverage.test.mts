import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import type { RunEvidence } from './coverage.mts';

import {
  changedLineCoverage,
  checkRevision,
  excerpt,
  groupRanges,
  mergeFileCoverage,
  suiteStatuses,
} from './coverage.mts';
import { git } from './changes.mts';

const HASH_A = 'a'.repeat(40);
const HASH_B = 'b'.repeat(40);

function statementEntry(hash: string, hits: Record<string, number>, path = '/repo/src/feature.ts') {
  return {
    path,
    hash,
    statementMap: Object.fromEntries(
      Object.keys(hits).map((id) => [
        id,
        { start: { line: Number(id) + 1, column: 0 }, end: { line: Number(id) + 1, column: 10 } },
      ]),
    ),
    fnMap: {},
    branchMap: {},
    s: hits,
    f: {},
    b: {},
  };
}

function run(label: string, overrides: Partial<RunEvidence> = {}): RunEvidence {
  return { label, coverage: {}, suites: [], ...overrides };
}

test('suiteStatuses flags runtime errors and failing assertions, and rejects a malformed report', () => {
  const statuses = suiteStatuses({
    testResults: [
      { name: '/repo/a.spec.js', status: 'passed', assertionResults: [{ status: 'passed' }] },
      { name: '/repo/b.spec.js', status: 'failed', assertionResults: [{ status: 'failed' }] },
      { name: '/repo/c.spec.js', status: 'failed', assertionResults: [] },
    ],
  });
  assert.deepEqual(statuses, [
    { testFilePath: '/repo/a.spec.js', failed: false, runtimeError: false },
    { testFilePath: '/repo/b.spec.js', failed: true, runtimeError: false },
    { testFilePath: '/repo/c.spec.js', failed: true, runtimeError: true },
  ]);
  assert.throws(
    () => suiteStatuses({ testResults: [{ status: 'passed' }] }),
    /Invalid Jest test result/u,
  );
  assert.throws(() => suiteStatuses({}), /Invalid Jest results JSON/u);
});

test('a clean matching run with zero hits is measured, not unavailable', () => {
  const file = '/repo/src/feature.ts';
  const coverage = { [file]: statementEntry(HASH_A, { '0': 0, '1': 0 }) };
  const result = mergeFileCoverage(file, [run('workspace tests', { coverage })]);
  assert.equal(result.state, 'measured');
  assert.deepEqual(result.reasons, []);
  assert.deepEqual(result.sources, ['workspace tests']);
  assert.ok(result.entry);
  assert.deepEqual(result.entry!.s, { '0': 0, '1': 0 });
});

test('no run producing the coverage key is unavailable', () => {
  const file = '/repo/src/feature.ts';
  const result = mergeFileCoverage(file, [run('workspace tests', { coverage: {} })]);
  assert.equal(result.state, 'unavailable');
  assert.deepEqual(result.sources, []);
});

test('a statement-map hash mismatch refuses to merge and marks the file incomplete', () => {
  const file = '/repo/src/feature.ts';
  const coverageA = { [file]: statementEntry(HASH_A, { '0': 1 }) };
  const coverageB = { [file]: statementEntry(HASH_B, { '0': 1 }) };
  const result = mergeFileCoverage(file, [
    run('native tests', { coverage: coverageA }),
    run('source-alias specs', { coverage: coverageB }),
  ]);
  assert.equal(result.state, 'incomplete');
  assert.ok(result.reasons.some((reason) => /hash differs/u.test(reason)));
  assert.equal(result.entry, undefined);
});

test('a hash missing from both contributing runs refuses to merge, not just a mismatch', () => {
  const file = '/repo/src/feature.ts';
  const withoutHash = (hits: Record<string, number>) => {
    const { hash, ...rest } = statementEntry(HASH_A, hits);
    return rest;
  };
  const result = mergeFileCoverage(file, [
    run('native tests', { coverage: { [file]: withoutHash({ '0': 1 }) } }),
    run('source-alias specs', { coverage: { [file]: withoutHash({ '0': 1 }) } }),
  ]);
  assert.equal(result.state, 'incomplete');
  assert.ok(result.reasons.some((reason) => /hash differs/u.test(reason)));
  assert.equal(result.entry, undefined);
});

test('a type-only file with an empty placeholder in every run merges as measured', () => {
  const file = '/repo/src/types.ts';
  // The shape istanbul writes for a file with nothing to instrument: empty maps, no hash.
  const placeholder = {
    path: file,
    statementMap: {},
    fnMap: {},
    branchMap: {},
    s: {},
    f: {},
    b: {},
  };
  const result = mergeFileCoverage(file, [
    run('native tests', { coverage: { [file]: placeholder } }),
    run('source-alias specs', { coverage: { [file]: { ...placeholder } } }),
  ]);
  assert.equal(result.state, 'measured');
  assert.deepEqual(result.reasons, []);
  assert.deepEqual(result.entry!.statementMap, {});
  assert.deepEqual(changedLineCoverage([1, 2], result.entry!).noStatement, [1, 2]);

  const instrumented = statementEntry(HASH_A, { '0': 1 }, file);
  const mixed = mergeFileCoverage(file, [
    run('native tests', { coverage: { [file]: placeholder } }),
    run('source-alias specs', { coverage: { [file]: instrumented } }),
  ]);
  assert.equal(mixed.state, 'incomplete');
  assert.ok(mixed.reasons.some((reason) => /hash differs/u.test(reason)));
});

test('a single usable run merges even with no hash field; nothing to compare it against', () => {
  const file = '/repo/src/feature.ts';
  const { hash, ...withoutHash } = statementEntry(HASH_A, { '0': 1 });
  const result = mergeFileCoverage(file, [
    run('native tests', { coverage: { [file]: withoutHash } }),
  ]);
  assert.equal(result.state, 'measured');
  assert.ok(result.entry);
});

test('matching path and hash merge hits from both runs instead of only one', () => {
  const file = '/repo/src/feature.ts';
  const coverageA = { [file]: statementEntry(HASH_A, { '0': 1, '1': 0 }) };
  const coverageB = { [file]: statementEntry(HASH_A, { '0': 0, '1': 3 }) };
  const result = mergeFileCoverage(file, [
    run('native tests', { coverage: coverageA }),
    run('source-alias specs', { coverage: coverageB }),
  ]);
  assert.equal(result.state, 'measured');
  const hits = result.entry!.s as Record<string, number>;
  assert.equal(hits['0'], 1);
  assert.equal(hits['1'], 3);
  assert.deepEqual(result.sources, ['native tests', 'source-alias specs']);
});

test('a related suite failure marks only the files it covers incomplete, even with merged hits', () => {
  const file = '/repo/src/feature.ts';
  const other = '/repo/src/other.ts';
  const coverage = {
    [file]: statementEntry(HASH_A, { '0': 1 }, file),
    [other]: statementEntry(HASH_B, { '0': 1 }, other),
  };
  const suites = [{ testFilePath: '/repo/api/featureSpec.js', failed: true, runtimeError: false }];
  const evidence = run('source-alias specs', {
    coverage,
    suites,
    relatedSpecs: { [file]: ['/repo/api/featureSpec.js'], [other]: ['/repo/api/otherSpec.js'] },
  });
  const featureResult = mergeFileCoverage(file, [evidence]);
  assert.equal(featureResult.state, 'incomplete');
  assert.ok(featureResult.entry, 'merge still succeeds; only the state is downgraded');
  assert.ok(featureResult.reasons.some((reason) => reason.includes('featureSpec.js')));

  const otherResult = mergeFileCoverage(other, [evidence]);
  assert.equal(otherResult.state, 'measured');
});

test('a relative file path attributes by the resolved key, not the raw argument', () => {
  // run.mts calls mergeFileCoverage with a repository-relative path, while `coverage` and
  // `relatedSpecs` are both keyed by resolve(file). Attribution must look the suite up under
  // that same resolved key, or every unrelated failing suite marks the file incomplete.
  const relativeFile = 'src/feature.ts';
  const key = resolve(relativeFile);
  const unrelatedSpec = resolve('src/other.spec.ts');
  const relatedSpec = resolve('src/feature.spec.ts');
  const coverage = { [key]: statementEntry(HASH_A, { '0': 1 }, key) };
  const relatedSpecs = { [key]: [relatedSpec] };

  const passing = run('workspace tests', {
    coverage,
    relatedSpecs,
    suites: [
      { testFilePath: unrelatedSpec, failed: true, runtimeError: false },
      { testFilePath: relatedSpec, failed: false, runtimeError: false },
    ],
  });
  const passingResult = mergeFileCoverage(relativeFile, [passing]);
  assert.equal(passingResult.state, 'measured');
  assert.deepEqual(passingResult.reasons, []);

  const failing = run('workspace tests', {
    coverage,
    relatedSpecs,
    suites: [
      { testFilePath: unrelatedSpec, failed: true, runtimeError: false },
      { testFilePath: relatedSpec, failed: true, runtimeError: false },
    ],
  });
  const failingResult = mergeFileCoverage(relativeFile, [failing]);
  assert.equal(failingResult.state, 'incomplete');
  assert.ok(failingResult.reasons.some((reason) => reason.includes('feature.spec.ts')));
  assert.ok(!failingResult.reasons.some((reason) => reason.includes('other.spec.ts')));
});

test('a revision mismatch discards that run and marks the file incomplete, not merged', () => {
  const file = '/repo/src/feature.ts';
  const coverage = { [file]: statementEntry(HASH_A, { '0': 1 }) };
  const result = mergeFileCoverage(file, [
    run('source-alias specs', {
      coverage,
      revision: {
        ok: false,
        head: 'deadbeef',
        reason: 'checkout HEAD deadbeef does not match tested head cafef00d',
      },
    }),
  ]);
  assert.equal(result.state, 'incomplete');
  assert.equal(result.entry, undefined);
  assert.ok(result.reasons.some((reason) => reason.includes('does not match tested head')));
});

test('a run marked runFailure discards its own evidence but native evidence still merges', () => {
  const file = '/repo/src/feature.ts';
  const coverage = { [file]: statementEntry(HASH_A, { '0': 1 }) };
  const result = mergeFileCoverage(file, [
    run('native tests', { coverage }),
    run('source-alias specs', {
      coverage: {},
      runFailure: 'api/ source-alias pass exceeded 20 min budget',
    }),
  ]);
  assert.equal(result.state, 'incomplete');
  assert.ok(result.entry, 'native evidence still merges');
  assert.ok(result.reasons.some((reason) => reason.includes('exceeded 20 min budget')));
  assert.ok(result.sources.includes('source-alias specs (discarded)'));
});

test('runFailure with no other usable run is incomplete, not unavailable', () => {
  const file = '/repo/src/feature.ts';
  const result = mergeFileCoverage(file, [
    run('source-alias specs', {
      coverage: {},
      runFailure: 'api/ source-alias pass crashed: exit 1',
    }),
  ]);
  assert.equal(result.state, 'incomplete');
  assert.equal(result.entry, undefined);
  assert.ok(result.reasons.some((reason) => reason.includes('crashed: exit 1')));
});

test('a multiline statement covers every changed line it spans; lines without one are not executable', () => {
  const entry = {
    statementMap: {
      '0': { start: { line: 2, column: 0 }, end: { line: 4, column: 1 } },
      '1': { start: { line: 6, column: 0 }, end: { line: 6, column: 10 } },
    },
    s: { '0': 1, '1': 0 },
  };
  const result = changedLineCoverage([2, 3, 4, 5, 6], entry);
  assert.deepEqual(result.covered, [2, 3, 4]);
  assert.deepEqual(result.uncovered, [6]);
  assert.deepEqual(result.noStatement, [5]);
});

test('an uncalled arrow body is uncovered even though its declaration line ran', () => {
  // const handler = () => {   <- line 1, declaration statement, hits > 0
  //   doWork();                <- line 2, its own statement, hits 0 (never called)
  // };
  const entry = {
    statementMap: {
      '0': { start: { line: 1, column: 0 }, end: { line: 3, column: 2 } },
      '1': { start: { line: 2, column: 2 }, end: { line: 2, column: 11 } },
    },
    s: { '0': 1, '1': 0 },
  };
  const result = changedLineCoverage([1, 2], entry);
  assert.deepEqual(result.covered, [1]);
  assert.deepEqual(result.uncovered, [2]);
});

test('a one-line if whose consequent did not run is still covered because the if itself ran', () => {
  // if (a) return b;  <- line 1: the `if` statement and the nested `return` both start here.
  const entry = {
    statementMap: {
      '0': { start: { line: 1, column: 0 }, end: { line: 1, column: 16 } }, // if (...)...
      '1': { start: { line: 1, column: 7 }, end: { line: 1, column: 16 } }, // return b;
    },
    s: { '0': 1, '1': 0 },
  };
  const result = changedLineCoverage([1], entry);
  assert.deepEqual(result.covered, [1]);
  assert.deepEqual(result.uncovered, []);
});

test('a multiline call with no statements starting on its argument lines is covered by the call statement', () => {
  // foo(          <- line 1: the call statement starts here, hits > 0
  //   a,          <- line 2: no statement starts here
  //   b,          <- line 3: no statement starts here
  // );            <- line 4: no statement starts here
  const entry = {
    statementMap: {
      '0': { start: { line: 1, column: 0 }, end: { line: 4, column: 2 } },
    },
    s: { '0': 1 },
  };
  const result = changedLineCoverage([1, 2, 3, 4], entry);
  assert.deepEqual(result.covered, [1, 2, 3, 4]);
  assert.deepEqual(result.uncovered, []);
  assert.deepEqual(result.noStatement, []);
});

test('groupRanges collapses consecutive lines and keeps separate gaps apart', () => {
  assert.deepEqual(groupRanges([8, 2, 3, 4, 10, 7]), [
    { start: 2, end: 4 },
    { start: 7, end: 8 },
    { start: 10, end: 10 },
  ]);
  assert.deepEqual(groupRanges([]), []);
});

test('excerpt keeps line breaks, cuts long lines and caps the line count', () => {
  const lines = ['const a = 1;', 'const b = a | 2;', 'const c = 3;'];
  assert.equal(excerpt(lines, { start: 1, end: 2 }), 'const a = 1;\nconst b = a | 2;');
  const long = excerpt(['x'.repeat(200)], { start: 1, end: 1 }, { maxChars: 20 });
  assert.equal(long, `${'x'.repeat(20)}…`);
  const tall = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`);
  assert.equal(
    excerpt(tall, { start: 1, end: 12 }, { maxLines: 3 }),
    'line 1\nline 2\nline 3\n… 9 more lines',
  );
  assert.equal(
    excerpt(tall, { start: 1, end: 4 }, { maxLines: 3 }),
    'line 1\nline 2\nline 3\n… 1 more line',
  );
});

test('checkRevision verifies the checkout head and rejects uncommitted changes to tested files', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'quality-coverage-revision-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'feature.ts'), 'export const value = 1;\n');
  git(['init', '-q'], directory);
  git(['add', '.'], directory);
  git(
    [
      '-c',
      'user.name=Quality Test',
      '-c',
      'user.email=quality@example.invalid',
      'commit',
      '--no-gpg-sign',
      '-qm',
      'fixture',
    ],
    directory,
  );
  const head = git(['rev-parse', 'HEAD'], directory).trim();

  const clean = checkRevision(directory, head, ['feature.ts']);
  assert.deepEqual(clean, { ok: true, head });

  const wrongHead = checkRevision(directory, '0'.repeat(40), ['feature.ts']);
  assert.equal(wrongHead.ok, false);
  assert.match(wrongHead.reason!, /does not match tested head/u);

  writeFileSync(join(directory, 'feature.ts'), 'export const value = 2;\n');
  const dirty = checkRevision(directory, head, ['feature.ts']);
  assert.equal(dirty.ok, false);
  assert.match(dirty.reason!, /uncommitted changes/u);
});
