import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';

import type {
  Finding,
  InvalidFinding,
  MutationSection,
  QualityFindings,
  RiskSection,
} from './findings.mts';

import {
  MAX_ARTIFACT_BYTES,
  MAX_REASON,
  MAX_TEXT,
  SCHEMA,
  findingKey,
  loadFindingsFile,
  truncate,
  unavailableMutation,
  unavailableRisk,
  validateFindings,
  writeFindings,
} from './findings.mts';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const IDENTITY = { repository: 'owner/repo', pr: 42, base: BASE, head: HEAD };

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    key: 'c'.repeat(64),
    file: 'packages/data-schemas/src/example.js',
    line: 1,
    column: 1,
    endLine: 1,
    endColumn: 10,
    mutator: 'BooleanLiteral',
    original: 'true',
    replacement: 'false',
    source: 'const x = true;',
    mutated: 'const x = false;',
    status: 'Survived',
    rank: 40,
    tags: ['behavior'],
    reason: 'A BooleanLiteral mutation in `example` was not detected by any test.',
    ...overrides,
  };
}

function invalid(overrides: Partial<InvalidFinding> = {}): InvalidFinding {
  return {
    file: 'packages/data-schemas/src/example.js',
    line: 2,
    column: 1,
    mutator: 'StringLiteral',
    original: '"a"',
    replacement: '""',
    status: 'RuntimeError',
    reason: 'boom',
    ...overrides,
  };
}

function mutation(overrides: Partial<MutationSection> = {}): MutationSection {
  return {
    ...unavailableMutation(),
    status: 'complete',
    planDigest: 'deadbeef',
    counts: {
      killed: 3,
      survived: 1,
      timeout: 0,
      noCoverage: 1,
      invalid: 1,
      ignored: 0,
      pending: 0,
    },
    scores: { killedByAssertion: 60, stryker: 60 },
    findings: [finding()],
    invalid: [invalid()],
    noCoverage: [{ file: 'packages/data-schemas/src/example.js', ranges: [{ start: 3, end: 4 }] }],
    ...overrides,
  };
}

function risk(overrides: Partial<RiskSection> = {}): RiskSection {
  return {
    workspace: 'api',
    status: 'complete',
    coverageScope: 'packages/api tests',
    summary: { files: 1, measured: 1, incomplete: 0, unavailable: 0, uncoveredLines: 2 },
    files: [
      {
        file: 'packages/api/src/a.ts',
        state: 'measured',
        scope: 'packages/api tests',
        reasons: [],
        gaps: [{ start: 5, end: 6, excerpt: 'return x;' }],
      },
    ],
    functions: [
      {
        file: 'packages/api/src/a.ts',
        name: 'run',
        line: 4,
        column: 1,
        complexity: 3,
        cognitiveComplexity: 2,
        coverage: 0.5,
        crap: 4.125,
        state: 'measured',
      },
    ],
    omitted: { files: 0, functions: 0 },
    failure: null,
    ...overrides,
  };
}

function document(overrides: Partial<QualityFindings> = {}): QualityFindings {
  return { schema: SCHEMA, ...IDENTITY, risk: [risk()], mutation: [mutation()], ...overrides };
}

test('truncate caps length and never splits a surrogate pair', () => {
  assert.equal(truncate('short', 10), 'short');
  const truncated = truncate('x'.repeat(200), 50);
  assert.ok(truncated.length <= 50);
  assert.ok(truncated.endsWith('…[truncated]'));
  assert.equal(truncate('x'.repeat(200), 10), 'x'.repeat(10));
  const withEmoji = 'a'.repeat(12) + '\u{1F600}' + 'a'.repeat(12);
  const lonely = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
  for (let max = 14; max <= 30; max += 1) assert.ok(!lonely.test(truncate(withEmoji, max)));
});

test('findingKey ignores position and distinguishes ordinals and functions', () => {
  const base = {
    file: 'packages/data-schemas/src/example.js',
    mutator: 'BooleanLiteral',
    original: 'true',
    replacement: 'false',
    functionName: 'example',
  };
  assert.equal(findingKey({ ...base, ordinal: 0 }), findingKey({ ...base, ordinal: 0 }));
  assert.notEqual(findingKey({ ...base, ordinal: 0 }), findingKey({ ...base, ordinal: 1 }));
  assert.notEqual(
    findingKey({ ...base, ordinal: 0 }),
    findingKey({ ...base, functionName: 'other', ordinal: 0 }),
  );
});

test('validateFindings accepts a well-formed document and the unavailable sections', () => {
  assert.equal(validateFindings(document()).ok, true);
  assert.equal(validateFindings(document({ pr: 0 })).ok, true, 'pr=0 means no pull request');
  assert.equal(
    validateFindings(
      document({ risk: [unavailableRisk('server')], mutation: [unavailableMutation()] }),
    ).ok,
    true,
  );
  assert.equal(validateFindings(document({ risk: [], mutation: [] })).ok, true);
});

test('validateFindings rejects each contract violation', () => {
  const rejects = (raw: unknown, pattern: RegExp) => {
    const result = validateFindings(raw);
    assert.equal(result.ok, false, JSON.stringify(raw).slice(0, 200));
    if (!result.ok) assert.match(result.error, pattern);
  };
  rejects(null, /object/);
  rejects({ ...document(), schema: 'quality-findings/v1' }, /schema/);
  rejects({ ...document(), extra: true }, /fields/);
  rejects(document({ repository: 'owner/repo/extra' }), /repository/);
  rejects(document({ pr: -1 }), /pr/);
  rejects(document({ base: 'not-a-sha' }), /base/);
  rejects(document({ head: 'A'.repeat(40) }), /head/);
  rejects(document({ risk: [risk(), risk()] }), /Duplicate change-risk/);
  rejects(document({ mutation: [mutation(), mutation()] }), /mutation/);
  rejects(document({ mutation: [mutation({ findings: [finding(), finding()] })] }), /Duplicate/);
  for (const file of ['../escape.js', '/abs.js', 'a\\b.js', 'line\nbreak.js', ''])
    rejects(document({ mutation: [mutation({ findings: [finding({ file })] })] }), /mutation/);
  rejects(document({ mutation: [mutation({ findings: [finding({ tags: [] })] })] }), /mutation/);
  rejects(
    document({ mutation: [mutation({ findings: [finding({ tags: ['secret' as never] })] })] }),
    /mutation/,
  );
  rejects(
    document({ mutation: [mutation({ findings: [finding({ mutator: 'Bad Mutator' })] })] }),
    /mutation/,
  );
  rejects(
    document({
      mutation: [mutation({ findings: [finding({ original: 'x'.repeat(MAX_TEXT + 1) })] })],
    }),
    /mutation/,
  );
  rejects(
    document({ mutation: [mutation({ findings: [{ ...finding(), extra: 1 } as Finding] })] }),
    /mutation/,
  );
  for (const field of ['source', 'mutated'] as const) {
    const { [field]: _dropped, ...without } = finding();
    rejects(document({ mutation: [mutation({ findings: [without as Finding] })] }), /mutation/);
    rejects(
      document({ mutation: [mutation({ findings: [finding({ [field]: 1 as never })] })] }),
      /mutation/,
    );
    rejects(
      document({
        mutation: [mutation({ findings: [finding({ [field]: 'x'.repeat(MAX_TEXT + 1) })] })],
      }),
      /mutation/,
    );
  }
  rejects(
    document({ mutation: [mutation({ scores: { killedByAssertion: 101, stryker: 0 } })] }),
    /mutation/,
  );
  rejects(
    document({
      mutation: [mutation({ noCoverage: [{ file: 'a.js', ranges: [{ start: 5, end: 4 }] }] })],
    }),
    /mutation/,
  );
  const [fn] = risk().functions;
  rejects(document({ risk: [risk({ functions: [{ ...fn, coverage: 1.5 }] })] }), /change-risk/);
  rejects(document({ risk: [risk({ workspace: 'client' as never })] }), /change-risk/);
  const [file] = risk().files;
  rejects(
    document({
      risk: [
        risk({
          files: [{ ...file, gaps: [{ start: 1, end: 1, excerpt: 'x', more: 1 } as never] }],
        }),
      ],
    }),
    /change-risk/,
  );
});

test('validateFindings ties a failed risk section to its failing tests', () => {
  const failure = {
    failedTests: 12,
    failedSuites: 1,
    tests: [
      { suite: 'packages/api/src/a.spec.ts', test: 'a fails' },
      { suite: 'packages/api/src/b.spec.ts', test: null },
    ],
  };
  const failed = { ...unavailableRisk('api'), status: 'failed' as const, failure };
  assert.equal(validateFindings(document({ risk: [failed] })).ok, true);
  const rejected = [
    { ...failed, failure: null },
    { ...unavailableRisk('api'), failure },
    { ...failed, failure: { ...failure, tests: Array(11).fill(failure.tests[0]) } },
    { ...failed, failure: { ...failure, tests: [{ suite: '/abs/a.spec.ts', test: 'x' }] } },
    { ...failed, failure: { ...failure, tests: [{ suite: 'a.spec.ts', test: '' }] } },
    { ...failed, failure: { ...failure, tests: [{ suite: 'a.spec.ts', test: 'x'.repeat(201) }] } },
    { ...failed, failure: { ...failure, failedTests: -1 } },
  ];
  for (const section of rejected)
    assert.equal(validateFindings(document({ risk: [section] })).ok, false);
});

test('validateFindings binds the document to the expected request', () => {
  assert.equal(validateFindings(document(), { ...IDENTITY, repository: 'Owner/Repo' }).ok, true);
  for (const [field, value, pattern] of [
    ['repository', 'other/repo', /repository/],
    ['pr', 43, /PR/],
    ['base', 'c'.repeat(40), /base/],
    ['head', 'c'.repeat(40), /head/],
  ] as const) {
    const result = validateFindings(document(), { ...IDENTITY, [field]: value });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, pattern);
  }
});

test('writeFindings caps text, keeps survivors last to go, and records what it omitted', () => {
  const directory = mkdtempSync(join(tmpdir(), 'quality-findings-'));
  try {
    const path = join(directory, 'findings.json');
    const big = 'y'.repeat(MAX_TEXT);
    const findings = Array.from({ length: 300 }, (_, index) =>
      finding({
        key: index.toString(16).padStart(64, '0'),
        original: big,
        replacement: big,
        source: big,
        mutated: big,
      }),
    );
    const invalids = Array.from({ length: 300 }, () =>
      invalid({ original: big, replacement: big }),
    );
    const written = writeFindings(
      path,
      document({
        mutation: [
          mutation({
            findings: [
              ...findings,
              finding({ key: 'f'.repeat(64), reason: 'r'.repeat(MAX_REASON + 50) }),
            ],
            invalid: invalids,
          }),
        ],
      }),
    );
    const raw = readFileSync(path, 'utf8');
    assert.ok(Buffer.byteLength(raw) <= MAX_ARTIFACT_BYTES);
    assert.equal(validateFindings(JSON.parse(raw)).ok, true);
    const [section] = written.mutation;
    assert.equal(section.invalid.length, 0, 'invalid mutants are trimmed before survivors');
    assert.equal(section.omitted.invalid, 300);
    assert.equal(section.findings.length + section.omitted.findings, 301);
    assert.ok(section.findings.length > 0);
    assert.deepEqual(section.findings[0], findings[0], 'the head of the ranked list survives');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('writeFindings truncates an over-long reason and refuses an invalid document', () => {
  const directory = mkdtempSync(join(tmpdir(), 'quality-findings-'));
  try {
    const path = join(directory, 'findings.json');
    const written = writeFindings(
      path,
      document({
        mutation: [
          mutation({
            findings: [
              finding({
                reason: 'r'.repeat(MAX_REASON + 1),
                source: 's'.repeat(MAX_TEXT + 1),
                mutated: 'm'.repeat(MAX_TEXT + 1),
              }),
            ],
          }),
        ],
      }),
    );
    const [written0] = written.mutation[0].findings;
    assert.equal(written0.reason.length, MAX_REASON);
    assert.equal(written0.source.length, MAX_TEXT);
    assert.equal(written0.mutated.length, MAX_TEXT);
    assert.throws(() => writeFindings(path, document({ head: 'nope' })), /Refusing/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('loadFindingsFile reads exactly one regular findings.json within the byte cap', () => {
  const directory = mkdtempSync(join(tmpdir(), 'quality-findings-load-'));
  try {
    assert.deepEqual(loadFindingsFile(join(directory, 'absent')), { ok: true, value: undefined });
    assert.deepEqual(loadFindingsFile(directory), { ok: true, value: undefined });
    const path = join(directory, 'findings.json');
    writeFileSync(path, JSON.stringify(document()));
    const loaded = loadFindingsFile(directory);
    assert.equal(loaded.ok && validateFindings(loaded.value).ok, true);
    writeFileSync(path, '{');
    assert.deepEqual(loadFindingsFile(directory), {
      ok: false,
      error: 'findings.json is not valid JSON',
    });
    writeFileSync(path, ' '.repeat(MAX_ARTIFACT_BYTES + 1));
    assert.match((loadFindingsFile(directory) as { error: string }).error, /size cap/);
    writeFileSync(join(directory, 'other.json'), '{}');
    assert.match((loadFindingsFile(directory) as { error: string }).error, /exactly one/);
    rmSync(join(directory, 'other.json'));
    rmSync(path);
    writeFileSync(join(directory, 'target.json'), JSON.stringify(document()));
    const linked = mkdtempSync(join(tmpdir(), 'quality-findings-link-'));
    symlinkSync(join(directory, 'target.json'), join(linked, 'findings.json'));
    assert.match((loadFindingsFile(linked) as { error: string }).error, /regular file/);
    rmSync(linked, { recursive: true, force: true });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
