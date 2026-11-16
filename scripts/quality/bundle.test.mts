import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strict as assert } from 'node:assert';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';

import type { QualityFindings } from './findings.mts';

import { SCHEMA, unavailableMutation, validateFindings } from './findings.mts';
import { bundle, discoverBase, failedSection, parseSelection, riskSection } from './bundle.mts';

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const IDENTITY = { repository: 'owner/repo', pr: 7, base: BASE, head: HEAD };

const riskReport = (overrides: Record<string, unknown> = {}) => ({
  base: BASE,
  head: HEAD,
  coverageScope: 'packages/api tests',
  functions: [
    {
      file: 'packages/api/src/low.ts',
      function: 'low',
      line: 3,
      column: 0,
      complexity: 1,
      cognitiveComplexity: 0,
      statementCoverage: 1,
      crap: 1,
      coverageState: 'measured',
    },
    {
      file: 'packages/api/src/high.ts',
      function: 'high',
      line: 10,
      column: 2,
      complexity: 6,
      cognitiveComplexity: 9,
      statementCoverage: 0,
      crap: 42,
      coverageState: 'measured',
    },
  ],
  testGaps: [
    {
      file: 'packages/api/src/low.ts',
      state: 'measured',
      scope: 'packages/api tests',
      reasons: [],
      gaps: [],
    },
    {
      file: 'packages/api/src/high.ts',
      state: 'measured',
      scope: 'packages/api tests',
      reasons: [],
      gaps: [{ start: 10, end: 12, excerpt: 'if (a) {\n  b();\n}' }],
    },
    {
      file: 'packages/api/src/partial.ts',
      state: 'incomplete',
      scope: 'packages/api tests',
      reasons: ['source map missing'],
      gaps: [],
    },
  ],
  ...overrides,
});

const mutationFindings = (overrides: Partial<QualityFindings> = {}): QualityFindings => ({
  schema: SCHEMA,
  ...IDENTITY,
  risk: [],
  mutation: [{ ...unavailableMutation(), status: 'complete', planDigest: 'abc123' }],
  ...overrides,
});

function workspace(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'quality-bundle-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'internal');
  const output = join(root, 'quality-report');
  const write = (artifact: string, file: string, content: unknown) => {
    mkdirSync(join(directory, artifact), { recursive: true });
    writeFileSync(
      join(directory, artifact, file),
      typeof content === 'string' ? content : JSON.stringify(content),
    );
  };
  return { root, directory, output, write };
}

const input = (directory: string, output: string, selection = parseSelection('[]')) => ({
  directory,
  output,
  ...IDENTITY,
  selection,
  hints: 10,
  repositoryUrl: 'https://github.com/owner/repo',
});

test('parseSelection reads the selected risk workspaces and mutation testing', () => {
  const raw = JSON.stringify([
    { workspace: 'server', task: { check: 'risk' } },
    { workspace: 'data-schemas', task: { check: 'mutation', shard: 1 } },
    { workspace: 'data-schemas', task: { check: 'mutation', shard: 2 } },
    { workspace: 'api', task: { check: 'risk' } },
  ]);
  assert.deepEqual(parseSelection(raw), { risk: ['api', 'server'], mutation: true });
  assert.deepEqual(parseSelection(''), { risk: [], mutation: false });
  assert.throws(() => parseSelection('{}'), /not a list/u);
  assert.throws(
    () => parseSelection('[{"workspace":"../x","task":{"check":"risk"}}]'),
    /workspace/u,
  );
  assert.throws(() => parseSelection('[{"workspace":"api","task":{"check":"rm"}}]'), /check/u);
});

test('riskSection maps risk.json, orders by uncovered lines and CRAP, and counts before cutting', () => {
  const section = riskSection(riskReport(), 'api', IDENTITY);
  assert.ok(section);
  assert.deepEqual(
    section.files.map(({ file }) => file),
    ['packages/api/src/high.ts', 'packages/api/src/partial.ts', 'packages/api/src/low.ts'],
  );
  assert.deepEqual(section.summary, {
    files: 3,
    measured: 2,
    incomplete: 1,
    unavailable: 0,
    uncoveredLines: 3,
  });
  assert.deepEqual(
    section.functions.map(({ name, crap }) => [name, crap]),
    [
      ['high', 42],
      ['low', 1],
    ],
  );
  assert.equal(riskSection({ functions: [] }, 'api', IDENTITY), undefined);
  // An unsafe path invalidates the section rather than reaching a link.
  const unsafe = riskReport();
  unsafe.testGaps[0].file = '../../etc/passwd';
  assert.equal(riskSection(unsafe, 'api', IDENTITY), undefined);
});

test('bundle writes the quality-report layout with findings, report and copied raw data', (t) => {
  const { directory, output, write } = workspace(t);
  write(`quality-internal-risk-api-${HEAD}`, 'risk.json', riskReport());
  write(`quality-internal-risk-api-${HEAD}`, 'summary.md', '# api summary\n');
  const mutation = `quality-internal-mutation-data-schemas-${HEAD}`;
  write(mutation, 'findings.json', mutationFindings());
  write(mutation, 'mutation.json', '{}');
  write(mutation, 'mutation.html', '<html></html>');
  write(mutation, 'report.md', '# mutation\n');
  const selection = parseSelection(
    JSON.stringify([
      { workspace: 'api', task: { check: 'risk' } },
      { workspace: 'server', task: { check: 'risk' } },
      { workspace: 'data-schemas', task: { check: 'mutation', shard: 1 } },
    ]),
  );
  const written = bundle(input(directory, output, selection));
  for (const file of [
    'findings.json',
    'report.md',
    'risk/api.json',
    'risk/api.md',
    'mutation/data-schemas.json',
    'mutation/data-schemas.html',
    'mutation/data-schemas.md',
  ])
    assert.ok(existsSync(join(output, file)), file);
  assert.equal(existsSync(join(output, 'risk/server.json')), false);
  const findings = JSON.parse(readFileSync(join(output, 'findings.json'), 'utf8'));
  assert.deepEqual(findings, written);
  assert.equal(validateFindings(findings, IDENTITY).ok, true);
  assert.deepEqual(
    findings.risk.map(({ workspace, status }: { workspace: string; status: string }) => [
      workspace,
      status,
    ]),
    [
      ['api', 'complete'],
      ['server', 'unavailable'],
    ],
  );
  assert.equal(findings.mutation[0].status, 'complete');
  const report = readFileSync(join(output, 'report.md'), 'utf8');
  assert.match(report, new RegExp(`^# Quality report for ${HEAD}\n`, 'u'));
  assert.match(report, /\| server \| report unavailable \|/u);
  assert.match(report, /`high`/u);
});

test('bundle marks a mutation report for another head, or a symlinked risk report, unavailable', (t) => {
  const { root, directory, output, write } = workspace(t);
  writeFileSync(join(root, 'secret.json'), JSON.stringify(riskReport()));
  mkdirSync(join(directory, `quality-internal-risk-api-${HEAD}`), { recursive: true });
  symlinkSync(
    join(root, 'secret.json'),
    join(directory, `quality-internal-risk-api-${HEAD}`, 'risk.json'),
  );
  write(
    `quality-internal-mutation-data-schemas-${HEAD}`,
    'findings.json',
    mutationFindings({ head: 'c'.repeat(40) }),
  );
  const selection = parseSelection(
    JSON.stringify([
      { workspace: 'api', task: { check: 'risk' } },
      { workspace: 'data-schemas', task: { check: 'mutation', shard: 1 } },
    ]),
  );
  const written = bundle(input(directory, output, selection));
  assert.equal(written.risk[0].status, 'unavailable');
  assert.equal(written.mutation[0].status, 'unavailable');
  assert.equal(existsSync(join(output, 'risk/api.json')), false, 'a symlink is never copied');
});

const failureRecord = (overrides: Record<string, unknown> = {}) => ({
  base: BASE,
  head: HEAD,
  failedTests: 3,
  failedSuites: 0,
  tests: [{ suite: 'packages/api/src/a.spec.ts', test: 'a > fails' }],
  ...overrides,
});

test('bundle reports a workspace whose Jest run failed with its failing tests', (t) => {
  const { directory, output, write } = workspace(t);
  write(`quality-internal-risk-api-${HEAD}`, 'failure.json', failureRecord());
  write(`quality-internal-risk-server-${HEAD}`, 'summary.md', 'Coverage failed.\n');
  write(
    `quality-internal-risk-data-schemas-${HEAD}`,
    'failure.json',
    failureRecord({ tests: [{ suite: '../outside.spec.ts', test: 'x' }] }),
  );
  const selection = parseSelection(
    JSON.stringify(
      ['data-schemas', 'api', 'server'].map((name) => ({
        workspace: name,
        task: { check: 'risk' },
      })),
    ),
  );
  const written = bundle(input(directory, output, selection));
  assert.equal(validateFindings(written, IDENTITY).ok, true);
  assert.deepEqual(
    written.risk.map(({ workspace, status }) => [workspace, status]),
    [
      ['data-schemas', 'unavailable'],
      ['api', 'failed'],
      ['server', 'unavailable'],
    ],
  );
  assert.deepEqual(written.risk[1].failure, {
    failedTests: 3,
    failedSuites: 0,
    tests: [{ suite: 'packages/api/src/a.spec.ts', test: 'a > fails' }],
  });
  const report = readFileSync(join(output, 'report.md'), 'utf8');
  assert.match(report, /\| api \| failed: 3 tests failed \|/u);
  assert.match(report, /\| server \| report unavailable \|/u);
  assert.match(report, /- api: `packages\/api\/src\/a\.spec\.ts` › `a > fails`/u);
});

test('failedSection caps the list and rejects a record that does not validate', () => {
  const many = Array.from({ length: 15 }, (_, index) => ({
    suite: 'packages/api/src/a.spec.ts',
    test: `case ${index}`,
  }));
  const section = failedSection(failureRecord({ tests: many }), 'api', IDENTITY);
  assert.equal(section?.failure?.tests.length, 10);
  assert.equal(failedSection(failureRecord({ failedTests: '3' }), 'api', IDENTITY), undefined);
  assert.equal(failedSection(failureRecord({ tests: 'x' }), 'api', IDENTITY), undefined);
  assert.equal(failedSection(null, 'api', IDENTITY), undefined);
});

test('discoverBase reads the base a manual run reported against', (t) => {
  const { directory, write } = workspace(t);
  const selection = { risk: ['api' as const], mutation: true };
  assert.equal(discoverBase(directory, HEAD, selection), undefined);
  write(`quality-internal-risk-api-${HEAD}`, 'risk.json', riskReport({ base: 'not-a-sha' }));
  assert.equal(discoverBase(directory, HEAD, selection), undefined);
  write(`quality-internal-mutation-data-schemas-${HEAD}`, 'findings.json', mutationFindings());
  assert.equal(discoverBase(directory, HEAD, selection), BASE);
  const failed = workspace(t);
  failed.write(`quality-internal-risk-api-${HEAD}`, 'failure.json', failureRecord());
  assert.equal(discoverBase(failed.directory, HEAD, { risk: ['api'], mutation: false }), BASE);
});
