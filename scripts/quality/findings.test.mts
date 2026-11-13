import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import type { Finding, QualityFindings } from './findings.mts';

import {
  checkFindings,
  ensureFindingsFile,
  findingKey,
  MAX_ARTIFACT_BYTES,
  MAX_DETECTED,
  MAX_REASON,
  MAX_TEXT,
  truncate,
  writeFindings,
} from './findings.mts';
import { MAX_ARTIFACT_BYTES as INLINE_MAX_ARTIFACT_BYTES, validateFindings } from './inline.mts';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);

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
    status: 'Survived',
    rank: 0,
    tags: ['behavior'],
    reason: 'A BooleanLiteral mutation was not detected by any test.',
    ...overrides,
  };
}

function findings(overrides: Partial<QualityFindings> = {}): QualityFindings {
  return {
    schema: 'quality-findings/v1',
    repository: 'owner/repo',
    pr: 42,
    base: BASE,
    head: HEAD,
    workspace: 'packages/data-schemas',
    planDigest: 'deadbeef',
    status: 'complete',
    findings: [finding()],
    detected: [],
    omitted: 0,
    ...overrides,
  };
}

test('truncate caps length and never splits a surrogate pair', () => {
  assert.equal(truncate('short', 10), 'short');
  const long = 'x'.repeat(200);
  const truncated = truncate(long, 50);
  assert.ok(truncated.length <= 50);
  assert.ok(truncated.endsWith('…[truncated]'));
  // Below the marker's own length there is no room left for it; the length bound still holds.
  const tiny = truncate(long, 10);
  assert.equal(tiny.length, 10);
  assert.equal(tiny, 'x'.repeat(10));
  // U+1F600 is a surrogate pair; truncating must never cut between the two units, for any cut
  // point near the pair (below, at, or past it).
  const withEmoji = 'a'.repeat(12) + '\u{1F600}' + 'a'.repeat(12);
  const lonelySurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
  for (let max = 14; max <= 30; max += 1) {
    const result = truncate(withEmoji, max);
    assert.ok(
      !lonelySurrogate.test(result),
      `must not split the surrogate pair: ${JSON.stringify(result)}`,
    );
  }
});

test('findingKey is stable across an unrelated line shift and distinguishes ordinals', () => {
  const base = {
    file: 'packages/data-schemas/src/example.js',
    mutator: 'BooleanLiteral',
    original: 'true',
    replacement: 'false',
    functionName: 'example',
  };
  // Nothing about the key formula takes a line/column, so an unrelated shift elsewhere in the
  // file (which never appears in these inputs at all) cannot change it.
  assert.equal(findingKey({ ...base, ordinal: 0 }), findingKey({ ...base, ordinal: 0 }));
  assert.notEqual(findingKey({ ...base, ordinal: 0 }), findingKey({ ...base, ordinal: 1 }));
  assert.notEqual(
    findingKey({ ...base, ordinal: 0 }),
    findingKey({ ...base, functionName: 'other', ordinal: 0 }),
  );
});

test('checkFindings accepts a well-formed artifact and rejects each contract violation', () => {
  assert.equal(checkFindings(findings()), undefined);
  assert.match(checkFindings(findings({ schema: 'quality-findings/v2' as never }))!, /schema/);
  assert.match(checkFindings(findings({ repository: '' }))!, /repository/);
  assert.match(checkFindings(findings({ pr: -1 }))!, /pr/);
  assert.equal(checkFindings(findings({ pr: 0 })), undefined, 'pr=0 means no pull request');
  assert.match(checkFindings(findings({ base: 'not-a-sha' }))!, /base/);
  assert.match(checkFindings(findings({ head: 'not-a-sha' }))!, /head/);
  assert.match(checkFindings(findings({ workspace: 'packages/api' as never }))!, /workspace/);
  assert.match(checkFindings(findings({ status: 'done' as never }))!, /status/);
  assert.match(
    checkFindings(findings({ findings: [finding({ status: 'Killed' as never })] }))!,
    /finding entry/,
  );
  assert.match(checkFindings(findings({ findings: [finding({ tags: [] })] }))!, /finding entry/);
  assert.match(
    checkFindings(
      findings({ findings: [finding({ key: 'd'.repeat(64) }), finding({ key: 'd'.repeat(64) })] }),
    )!,
    /Duplicate finding key/,
  );
  assert.match(checkFindings(findings({ reportUrl: 'http://insecure' }))!, /report URL/);
  assert.equal(checkFindings(findings({ reportUrl: 'https://example.invalid/report' })), undefined);
});

test('checkFindings validates detected as a bounded array of unique, well-formed keys', () => {
  assert.equal(checkFindings(findings({ detected: [] })), undefined);
  assert.equal(checkFindings(findings({ detected: ['a'.repeat(64), 'b'.repeat(64)] })), undefined);
  assert.match(checkFindings(findings({ detected: undefined as never }))!, /detected list/);
  assert.match(checkFindings(findings({ detected: 'a'.repeat(64) as never }))!, /detected list/);
  assert.match(
    checkFindings(
      findings({ detected: Array.from({ length: MAX_DETECTED + 1 }, () => 'a'.repeat(64)) }),
    )!,
    /detected list/,
  );
  assert.match(checkFindings(findings({ detected: ['not-hex'] }))!, /detected key/);
  assert.match(checkFindings(findings({ detected: ['a'.repeat(63)] }))!, /detected key/);
  assert.match(
    checkFindings(findings({ detected: ['a'.repeat(64), 'a'.repeat(64)] }))!,
    /Duplicate detected key/,
  );
});

test('checkFindings rejects a missing, negative, or non-integer omitted count, but accepts one above the 2000-finding cap', () => {
  assert.match(checkFindings(findings({ omitted: undefined as never }))!, /omitted/);
  assert.match(checkFindings(findings({ omitted: -1 }))!, /omitted/);
  assert.match(checkFindings(findings({ omitted: 1.5 }))!, /omitted/);
  assert.equal(checkFindings(findings({ omitted: 0 })), undefined);
  assert.equal(checkFindings(findings({ omitted: 2000 })), undefined);
  // omitted counts findings dropped for exceeding the 2000-finding cap too, not just the byte
  // budget, so a value above 2000 is a legitimate overflow count, not a contract violation.
  assert.equal(checkFindings(findings({ omitted: 2001 })), undefined);
});

test('writeFindings truncates oversized text and refuses to write an invalid artifact', () => {
  const directory = mkdtempSync(join(tmpdir(), 'quality-findings-'));
  try {
    const path = join(directory, 'findings.json');
    const oversized = findings({
      findings: [
        finding({
          original: 'x'.repeat(MAX_TEXT + 500),
          replacement: 'y'.repeat(MAX_TEXT + 500),
          reason: 'z'.repeat(MAX_REASON + 500),
        }),
      ],
    });
    const written = writeFindings(path, oversized);
    assert.ok(written.findings[0].original.length <= MAX_TEXT);
    assert.ok(written.findings[0].replacement.length <= MAX_TEXT);
    assert.ok(written.findings[0].reason.length <= MAX_REASON);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), written);

    assert.throws(
      () => writeFindings(path, findings({ repository: '' })),
      /Refusing to write invalid findings artifact/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('inline.mts imports the same MAX_ARTIFACT_BYTES rather than keeping its own copy', () => {
  assert.equal(INLINE_MAX_ARTIFACT_BYTES, MAX_ARTIFACT_BYTES);
});

test('writeFindings drops the lowest-ranked findings to fit MAX_ARTIFACT_BYTES, records omitted, and the result still validates', () => {
  const directory = mkdtempSync(join(tmpdir(), 'quality-findings-budget-'));
  try {
    const path = join(directory, 'findings.json');
    const total = 500;
    const oversized = findings({
      findings: Array.from({ length: total }, (_, index) =>
        finding({
          key: index.toString(16).padStart(64, '0'),
          rank: index,
          original: 'x'.repeat(MAX_TEXT),
          replacement: 'y'.repeat(MAX_TEXT),
        }),
      ),
    });
    const written = writeFindings(path, oversized);
    const bytes = Buffer.byteLength(JSON.stringify(written, null, 2), 'utf8');
    assert.ok(bytes <= MAX_ARTIFACT_BYTES, `expected <= ${MAX_ARTIFACT_BYTES} bytes, got ${bytes}`);
    assert.ok(written.omitted > 0, 'expected some findings to have been dropped');
    assert.equal(written.findings.length + written.omitted, total);
    // The kept findings are exactly the lowest-rank (highest-priority) prefix, in order.
    assert.deepEqual(
      written.findings.map((item) => item.rank),
      Array.from({ length: written.findings.length }, (_, index) => index),
    );
    const validated = validateFindings(written, {
      repository: written.repository,
      pr: written.pr,
      base: written.base,
      head: written.head,
    });
    assert.equal(validated.ok, true, validated.ok ? undefined : validated.error);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), written);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('writeFindings keeps every finding and truncates only detected when detected alone exceeds the byte budget', () => {
  const directory = mkdtempSync(join(tmpdir(), 'quality-findings-detected-'));
  try {
    const path = join(directory, 'findings.json');
    const hugeDetected = Array.from({ length: 20_000 }, (_, index) =>
      index.toString(16).padStart(64, '0'),
    );
    const oversized = findings({ detected: hugeDetected });
    const written = writeFindings(path, oversized);
    const bytes = Buffer.byteLength(JSON.stringify(written, null, 2), 'utf8');
    assert.ok(bytes <= MAX_ARTIFACT_BYTES, `expected <= ${MAX_ARTIFACT_BYTES} bytes, got ${bytes}`);
    // Not a single finding was dropped; only detected shrank to make room.
    assert.equal(written.findings.length, oversized.findings.length);
    assert.equal(written.omitted, 0);
    assert.ok(written.detected.length < hugeDetected.length);
    // The kept detected keys are a prefix, in the artifact's original order.
    assert.deepEqual(written.detected, hugeDetected.slice(0, written.detected.length));
    const validated = validateFindings(written, {
      repository: written.repository,
      pr: written.pr,
      base: written.base,
      head: written.head,
    });
    assert.equal(validated.ok, true, validated.ok ? undefined : validated.error);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('writeFindings gives findings strict priority: an oversized detected list never causes a finding to be dropped', () => {
  const directory = mkdtempSync(join(tmpdir(), 'quality-findings-priority-'));
  try {
    const path = join(directory, 'findings.json');
    const total = 500;
    const manyFindings = Array.from({ length: total }, (_, index) =>
      finding({
        key: index.toString(16).padStart(64, '0'),
        rank: index,
        original: 'x'.repeat(MAX_TEXT),
        replacement: 'y'.repeat(MAX_TEXT),
      }),
    );
    const withoutDetected = writeFindings(
      join(directory, 'without.json'),
      findings({ findings: manyFindings }),
    );
    const hugeDetected = Array.from({ length: 5000 }, (_, index) =>
      index.toString(16).padStart(64, '0'),
    );
    const withDetected = writeFindings(
      path,
      findings({ findings: manyFindings, detected: hugeDetected }),
    );
    // Adding a large detected list changes nothing about which findings survive the byte budget.
    assert.equal(withDetected.findings.length, withoutDetected.findings.length);
    assert.equal(withDetected.omitted, withoutDetected.omitted);
    assert.deepEqual(
      withDetected.findings.map((item) => item.key),
      withoutDetected.findings.map((item) => item.key),
    );
    const bytes = Buffer.byteLength(JSON.stringify(withDetected, null, 2), 'utf8');
    assert.ok(bytes <= MAX_ARTIFACT_BYTES, `expected <= ${MAX_ARTIFACT_BYTES} bytes, got ${bytes}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('writeFindings caps the kept findings at the 2000-finding limit even when each one is short enough to fit the byte budget', () => {
  const directory = mkdtempSync(join(tmpdir(), 'quality-findings-count-'));
  try {
    const path = join(directory, 'findings.json');
    const total = 2001;
    const oversized = findings({
      findings: Array.from({ length: total }, (_, index) =>
        finding({ key: index.toString(16).padStart(64, '0'), rank: index }),
      ),
    });
    const written = writeFindings(path, oversized);
    assert.equal(written.findings.length, 2000);
    assert.equal(written.omitted, 1);
    // The kept findings are exactly the lowest-rank (highest-priority) prefix, in order.
    assert.deepEqual(
      written.findings.map((item) => item.rank),
      Array.from({ length: 2000 }, (_, index) => index),
    );
    const validated = validateFindings(written, {
      repository: written.repository,
      pr: written.pr,
      base: written.base,
      head: written.head,
    });
    assert.equal(validated.ok, true, validated.ok ? undefined : validated.error);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), written);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('mutator and tag validation agree between the writer and the privileged consumer', () => {
  const variants: Array<[string, Partial<Finding>]> = [
    ['valid letters-only mutator', {}],
    ['mutator with digits', { mutator: 'Block1' }],
    ['empty mutator', { mutator: '' }],
    ['oversize mutator', { mutator: 'x'.repeat(201) }],
    ['mutator with scope syntax', { mutator: '@org/team' }],
    ['no tags', { tags: [] }],
    ['unknown tag', { tags: ['exploit'] as never }],
    ['valid tag', { tags: ['tenant'] }],
  ];
  for (const [label, override] of variants) {
    const doc = findings({ findings: [finding(override)] });
    const producerOk = checkFindings(doc) === undefined;
    const consumerResult = validateFindings(doc, {
      repository: doc.repository,
      pr: doc.pr,
      base: doc.base,
      head: doc.head,
    });
    assert.equal(consumerResult.ok, producerOk, label);
  }
});

test('a writer-produced findings artifact passes the privileged consumer check in inline.mts', () => {
  const data = findings();
  const result = validateFindings(data, {
    repository: data.repository,
    pr: data.pr,
    base: data.base,
    head: data.head,
  });
  assert.equal(result.ok, true, result.ok ? undefined : result.error);
});

test('ensureFindingsFile writes a trusted unavailable placeholder only when none exists', () => {
  const directory = mkdtempSync(join(tmpdir(), 'quality-ensure-'));
  try {
    const path = join(directory, 'nested', 'findings.json');
    const written = ensureFindingsFile(path, {
      repository: 'owner/repo',
      pr: 3,
      base: BASE,
      head: HEAD,
    });
    assert.ok(written);
    assert.equal(written!.status, 'unavailable');
    assert.deepEqual(written!.findings, []);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), written);

    // A merge step that already produced a real artifact must never be overwritten.
    const real = findings({ status: 'complete' });
    writeFileSync(path, JSON.stringify(real));
    const skipped = ensureFindingsFile(path, {
      repository: 'owner/repo',
      pr: 3,
      base: BASE,
      head: HEAD,
    });
    assert.equal(skipped, undefined);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), real);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('ensureFindingsFile leaves findings.json absent rather than invalid when no base is known', () => {
  const directory = mkdtempSync(join(tmpdir(), 'quality-ensure-'));
  try {
    const path = join(directory, 'findings.json');
    const written = ensureFindingsFile(path, {
      repository: 'owner/repo',
      pr: 0,
      base: '',
      head: HEAD,
    });
    assert.equal(written, undefined);
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
