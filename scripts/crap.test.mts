import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import { crapScore, createReport, measureFunctions } from './crap.mts';

const FILE = resolve('sample.ts');
const SCRIPT = fileURLToPath(new URL('./crap.mts', import.meta.url));

function coverageFor(source: string, statements: [string, number][], file = FILE) {
  const position = (index: number) => {
    const lines = source.slice(0, index).split('\n');
    return { line: lines.length, column: lines.at(-1)!.length };
  };
  return {
    path: file,
    statementMap: Object.fromEntries(
      statements.map(([text], id) => {
        const start = source.indexOf(text);
        assert.notEqual(start, -1, `Missing fixture statement: ${text}`);
        return [id, { start: position(start), end: position(start + text.length) }];
      }),
    ),
    s: Object.fromEntries(statements.map(([, hits], id) => [id, hits])),
  };
}

test('CRAP uses statement coverage fractions and preserves unknown coverage', () => {
  assert.equal(crapScore(4, 1), 4);
  assert.equal(crapScore(4, 0), 20);
  assert.equal(crapScore(3, 0.5), 4.125);
  assert.equal(crapScore(4, null), null);
  for (const coverage of [-1, 1.1, NaN, Infinity]) {
    assert.throws(() => crapScore(4, coverage), /fraction/);
  }
  for (const complexity of [0, -1, 1.5, Infinity]) {
    assert.throws(() => crapScore(complexity, 1), /positive integer/);
  }
});

test('real ESLint counts classic switch cases, logical and conditional branches in TypeScript', () => {
  const source = `/* eslint complexity: off */
function choose(value: number): number {
  switch (value) {
    case 0: return 0;
    case 1: return 1;
    default: return value > 2 && value < 5 ? 2 : -1;
  }
}`;
  const [row] = measureFunctions(FILE, source);
  assert.equal(row.function, 'choose');
  assert.equal(row.line, 2);
  assert.equal(row.complexity, 5);
  assert.equal(row.statementCoverage, null);
  assert.equal(row.crap, null);
});

test('nested functions own only their statements, including when sharing a line', () => {
  for (const separator of [' ', '\n']) {
    const source = `const outer = () => {${separator}const inner = () => 1;${separator}return inner(); };`;
    const coverage = coverageFor(source, [
      ['const inner = () => 1;', 0],
      ['1', 1],
      ['return inner();', 0],
    ]);
    const [outer, inner] = measureFunctions(FILE, source, coverage);
    assert.equal(outer.function, 'outer');
    assert.equal(outer.complexity, 1);
    assert.equal(outer.statements, 2);
    assert.equal(outer.coveredStatements, 0);
    assert.equal(outer.statementCoverage, 0);
    assert.equal(outer.crap, 2);
    assert.equal(inner.function, 'inner');
    assert.equal(inner.statements, 1);
    assert.equal(inner.statementCoverage, 1);
    assert.equal(inner.crap, inner.complexity);
  }
});

test('nested branches and implicit class initializers do not inflate enclosing complexity', () => {
  const source = `function outer() {
  class Box {
    value = true ? 1 : 2;
    handler = () => false ? 1 : 2;
  }
  return Box;
}`;
  const rows = measureFunctions(FILE, source);
  assert.deepEqual(
    rows.map((row) => [row.function, row.complexity]),
    [
      ['outer', 1],
      ['handler', 2],
    ],
  );
});

test('attributes method diagnostics reported before the function node itself', () => {
  const source = `const box = {
  read(value: number) { if (value) return 1; return 0; },
  write: (value: number) => value ? 1 : 0,
};`;
  const rows = measureFunctions(FILE, source);
  assert.deepEqual(
    rows.map((row) => [row.function, row.complexity]),
    [
      ['read', 2],
      ['write', 2],
    ],
  );
});

test('missing or empty instrumentation is N/A, not 100%; explicit zero hits stays zero', () => {
  const source = 'const value = 1; function read() { return value; }';
  const missing = [
    undefined,
    coverageFor(source, []),
    coverageFor(source, [['const value = 1;', 1]]),
  ];
  for (const coverage of missing) {
    const [row] = measureFunctions(FILE, source, coverage);
    assert.equal(row.statements, 0);
    assert.equal(row.statementCoverage, null);
    assert.equal(row.crap, null);
  }
  const [zero] = measureFunctions(FILE, source, coverageFor(source, [['return value;', 0]]));
  assert.equal(zero.statementCoverage, 0);
  assert.equal(zero.crap, 2);
});

test('rejects malformed coverage, counter mismatches and stale out-of-source ranges', () => {
  const source = 'function read() { return 1; }';
  const valid = coverageFor(source, [['return 1;', 1]]);
  const bad = [
    null,
    [],
    {},
    { ...valid, path: resolve('other.ts') },
    { ...valid, s: {} },
    { ...valid, s: { 1: 1 } },
    { ...valid, s: { 0: -1 } },
    { ...valid, s: { 0: 0.5 } },
    { ...valid, s: { 0: '1' } },
    ...[
      { line: 0, column: 0 },
      { line: 2, column: 0 },
      { line: 1, column: source.length + 1 },
      { line: 1, column: -1 },
      { line: 1, column: 1.5 },
      { line: 1, column: source.length },
    ].map((start) => ({ ...valid, statementMap: { 0: { ...valid.statementMap[0], start } } })),
  ];
  for (const coverage of bad) {
    assert.throws(() => measureFunctions(FILE, source, coverage), /invalid|mismatch|outside/i);
  }
  assert.throws(() => measureFunctions(FILE, 'function broken('), /Parsing error/);
});

test('validates CRLF source locations', () => {
  const source = 'function read() {\r\n  return 1;\r\n}';
  const coverage = {
    path: FILE,
    statementMap: { 0: { start: { line: 2, column: 2 }, end: { line: 2, column: 11 } } },
    s: { 0: 1 },
  };
  assert.equal(measureFunctions(FILE, source, coverage)[0].statementCoverage, 1);
});

test('CLI resolves source/output paths from package cwd and writes advisory JSON', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'crap-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const cwd = join(directory, 'package');
  const file = join(cwd, 'src', 'favorite.ts');
  const coverageFile = join(cwd, 'coverage', 'favorites', 'coverage-final.json');
  mkdirSync(join(cwd, 'src'), { recursive: true });
  mkdirSync(join(cwd, 'coverage', 'favorites'), { recursive: true });
  const source = 'export function read(): number { return 1; }';
  writeFileSync(file, source);
  writeFileSync(
    coverageFile,
    JSON.stringify({ [file]: coverageFor(source, [['return 1;', 0]], file) }),
  );
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' });
  const result = run('coverage/favorites/coverage-final.json', 'src/favorite.ts');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Advisory CRAP/);
  assert.match(result.stdout, /0\.0% \(0\/1\)\s+2\.00/);
  const report = JSON.parse(readFileSync(join(cwd, 'coverage', 'favorites', 'crap.json'), 'utf8'));
  assert.deepEqual(report, createReport(coverageFile, [file]));
  assert.equal(report.functions[0].file, file);
  assert.equal(run('--output', 'custom/crap.json', coverageFile, file).status, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(cwd, 'custom', 'crap.json'), 'utf8')), report);
  assert.equal(run('--output', file, coverageFile, file).status, 1);
  assert.equal(readFileSync(file, 'utf8'), source);
  assert.throws(() => createReport(join(directory, 'missing.json'), [file]), /ENOENT/);
  assert.throws(() => createReport(coverageFile, [join(directory, 'missing.ts')]), /ENOENT/);
  writeFileSync(coverageFile, '{}');
  const unknown = run(coverageFile, file);
  assert.equal(unknown.status, 0, unknown.stderr);
  assert.match(unknown.stdout, /N\/A\s+N\/A/);
  const defaults = run(coverageFile);
  assert.equal(defaults.status, 0, defaults.stderr);
  const defaultReport = JSON.parse(
    readFileSync(join(cwd, 'coverage', 'favorites', 'crap.json'), 'utf8'),
  );
  assert.ok(defaultReport.functions.length > 0);
  assert.ok(
    defaultReport.functions.every(
      (row: { file: string }) => row.file === 'packages/data-schemas/src/methods/favorite.ts',
    ),
  );
  writeFileSync(coverageFile, '{invalid');
  assert.equal(run(coverageFile, file).status, 1);
  writeFileSync(coverageFile, '[]');
  assert.throws(() => createReport(coverageFile, [file]), /Istanbul coverage object/);
});

test('importing the reporter does not execute its CLI', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import ${JSON.stringify(new URL('./crap.mts', import.meta.url).href)}`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});
