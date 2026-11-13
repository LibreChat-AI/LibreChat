import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import type { MutationReport } from './merge.mts';
import type { ShardPlan } from './shards.mts';

import {
  buildFindings,
  codeCell,
  ignoredBreakdown,
  invalidMutants,
  noCoverageRanges,
  rankOf,
  renderMarkdown,
  scores,
  statusCounts,
  tagsFor,
} from './report.mts';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const META = {
  repository: 'owner/repo',
  pr: 1,
  base: BASE,
  head: HEAD,
  workspace: 'packages/data-schemas' as const,
  planDigest: 'digest',
  status: 'complete' as const,
  omitted: 0,
};

type ReportMutant = MutationReport['files'][string]['mutants'][number];

function mutant(overrides: Partial<ReportMutant> = {}): ReportMutant {
  return {
    id: '0',
    status: 'Survived',
    mutatorName: 'BooleanLiteral',
    replacement: 'false',
    location: { start: { line: 1, column: 1 }, end: { line: 1, column: 5 } },
    ...overrides,
  };
}

function report(files: MutationReport['files']): MutationReport {
  return { schemaVersion: '1.0', thresholds: { high: 90, low: 70 }, files };
}

test('Timeout is never counted as killed by assertion, but counts toward the Stryker score', () => {
  const counts = new Map([
    ['Killed', 2],
    ['Timeout', 3],
    ['Survived', 1],
    ['NoCoverage', 4],
  ]);
  const { killedByAssertion, strykerScore } = scores(counts);
  // 2 / (2 + 1 + 4) = 28.57%; Timeout is excluded from both the numerator and this denominator.
  assert.equal(killedByAssertion!.toFixed(2), '28.57');
  // (2 + 3) / (2 + 3 + 1 + 4) = 50.00%; Timeout counts as detected only in the labeled Stryker score.
  assert.equal(strykerScore!.toFixed(2), '50.00');
});

test('statusCounts keeps Killed, Timeout, Survived, NoCoverage, Ignored, and invalid statuses distinct', () => {
  const counts = statusCounts(
    report({
      'a.js': {
        source: '',
        language: 'javascript',
        mutants: [
          mutant({ id: '1', status: 'Killed' }),
          mutant({ id: '2', status: 'Timeout' }),
          mutant({ id: '3', status: 'Survived' }),
          mutant({ id: '4', status: 'NoCoverage' }),
          mutant({ id: '5', status: 'Ignored' }),
          mutant({ id: '6', status: 'CompileError' }),
        ],
      },
    }),
  );
  assert.equal(counts.get('Killed'), 1);
  assert.equal(counts.get('Timeout'), 1);
  assert.equal(counts.get('Survived'), 1);
  assert.equal(counts.get('NoCoverage'), 1);
  assert.equal(counts.get('Ignored'), 1);
  assert.equal(counts.get('CompileError'), 1);
  // No status was folded into another.
  assert.equal(
    [...counts.values()].reduce((a, b) => a + b, 0),
    6,
  );
});

test('ignoredBreakdown separates static, logging-only, and a comment-given reason', () => {
  const buckets = ignoredBreakdown(
    report({
      'a.js': {
        source: '',
        language: 'javascript',
        mutants: [
          mutant({
            id: '1',
            status: 'Ignored',
            statusReason: 'Static mutant (and "ignoreStatic" was enabled)',
          }),
          mutant({ id: '2', status: 'Ignored', statusReason: 'logging-only' }),
          mutant({ id: '3', status: 'Ignored', statusReason: 'Known flaky' }),
          mutant({ id: '4', status: 'Ignored' }),
        ],
      },
    }),
  );
  assert.equal(buckets.get('static'), 1);
  assert.equal(buckets.get('logging-only'), 1);
  assert.equal(buckets.get('Known flaky'), 1);
  assert.equal(buckets.get('unspecified'), 1);
});

test('noCoverageRanges groups NoCoverage mutants per file into contiguous line ranges', () => {
  const ranges = noCoverageRanges(
    report({
      'a.js': {
        source: '',
        language: 'javascript',
        mutants: [
          mutant({
            id: '1',
            status: 'NoCoverage',
            location: { start: { line: 5, column: 1 }, end: { line: 5, column: 2 } },
          }),
          mutant({
            id: '2',
            status: 'NoCoverage',
            location: { start: { line: 6, column: 1 }, end: { line: 6, column: 2 } },
          }),
          mutant({
            id: '3',
            status: 'NoCoverage',
            location: { start: { line: 10, column: 1 }, end: { line: 10, column: 2 } },
          }),
          mutant({ id: '4', status: 'Survived' }),
        ],
      },
    }),
  );
  assert.deepEqual(ranges.get('a.js'), [
    { start: 5, end: 6 },
    { start: 10, end: 10 },
  ]);
});

test('tenant and filter-emptying survivors outrank a plain behavior survivor; a new function alone does not raise rank', () => {
  const behaviorTags = tagsFor({
    original: 'a > b',
    replacement: 'a >= b',
    functionName: 'helper',
    file: 'packages/data-schemas/src/example.js',
  });
  assert.deepEqual(behaviorTags, ['behavior']);
  const behaviorRank = rankOf(behaviorTags, 'EqualityOperator', 'a >= b');

  const tenantTags = tagsFor({
    original: 'query.tenantId = tenantId',
    replacement: '',
    functionName: 'helper',
    file: 'packages/data-schemas/src/example.js',
  });
  assert.deepEqual(tenantTags, ['tenant']);
  const tenantRank = rankOf(tenantTags, 'EqualityOperator', '');
  assert.ok(tenantRank < behaviorRank, 'tenant survivor must outrank a plain behavior survivor');

  const filterTags = tagsFor({
    original: '{ tenantId }',
    replacement: '{}',
    functionName: 'helper',
    file: 'packages/data-schemas/src/example.js',
  });
  assert.ok(filterTags.includes('data-loss'));
  const filterRank = rankOf(filterTags, 'ObjectLiteral', '{}');
  assert.ok(
    filterRank < behaviorRank,
    'emptying a filter object must outrank a plain behavior survivor',
  );

  // Being inside a brand-new function is not an input to tagsFor/rankOf at all, so the same
  // mutation in a different (newly added) function must produce the identical rank.
  const sameInDifferentFunction = tagsFor({
    original: 'a > b',
    replacement: 'a >= b',
    functionName: 'brandNewFunction',
    file: 'packages/data-schemas/src/example.js',
  });
  assert.deepEqual(sameInDifferentFunction, behaviorTags);
  assert.equal(rankOf(sameInDifferentFunction, 'EqualityOperator', 'a >= b'), behaviorRank);
});

test('buildFindings only includes Survived mutants and gives identical tuples distinct keys', () => {
  const plan: ShardPlan = {
    base: BASE,
    head: HEAD,
    workspace: 'data-schemas',
    digest: 'digest',
    staticMutants: true,
    shards: [
      {
        index: 1,
        targets: [
          {
            file: 'packages/data-schemas/src/example.js',
            mutate: [],
            suppressions: [],
            functions: [
              {
                function: 'example',
                line: 1,
                column: 1,
                location: { start: { line: 1, column: 1 }, end: { line: 3, column: 1 } },
              },
            ],
          },
        ],
        expected: [],
      },
    ],
  };
  const data = report({
    'packages/data-schemas/src/example.js': {
      source: 'return true;\nreturn true;\nreturn false;\n',
      language: 'javascript',
      mutants: [
        mutant({ id: '1', status: 'Killed' }),
        mutant({
          id: '2',
          status: 'Survived',
          location: { start: { line: 1, column: 8 }, end: { line: 1, column: 12 } },
        }),
        mutant({
          id: '3',
          status: 'Survived',
          location: { start: { line: 2, column: 8 }, end: { line: 2, column: 12 } },
        }),
      ],
    },
  });
  const findings = buildFindings(data, plan, META);
  assert.equal(findings.findings.length, 2);
  assert.ok(findings.findings.every((finding) => finding.status === 'Survived'));
  // Both survivors share file/mutator/original/replacement/function (identical tuple); the
  // ordinal is what tells them apart, so their keys must differ.
  const [first, second] = findings.findings;
  assert.notEqual(first.key, second.key);
});

test('an earlier identical mutant being Killed does not shift a later survivor onto its key', () => {
  const plan: ShardPlan = {
    base: BASE,
    head: HEAD,
    workspace: 'data-schemas',
    digest: 'digest',
    staticMutants: true,
    shards: [
      {
        index: 1,
        targets: [
          {
            file: 'packages/data-schemas/src/example.js',
            mutate: [],
            suppressions: [],
            functions: [
              {
                function: 'example',
                line: 1,
                column: 1,
                location: { start: { line: 1, column: 1 }, end: { line: 3, column: 1 } },
              },
            ],
          },
        ],
        expected: [],
      },
    ],
  };
  const source = 'return true;\nreturn true;\n';
  const identicalMutants = [
    mutant({
      id: '1',
      status: 'Survived',
      location: { start: { line: 1, column: 8 }, end: { line: 1, column: 12 } },
    }),
    mutant({
      id: '2',
      status: 'Survived',
      location: { start: { line: 2, column: 8 }, end: { line: 2, column: 12 } },
    }),
  ];

  const bothSurvived = buildFindings(
    report({
      'packages/data-schemas/src/example.js': {
        source,
        language: 'javascript',
        mutants: identicalMutants,
      },
    }),
    plan,
    META,
  );
  assert.equal(bothSurvived.findings.length, 2);
  const [k0, k1] = bothSurvived.findings.map((finding) => finding.key);
  assert.notEqual(k0, k1);

  // The first of the two identical mutants (lower line) is now Killed; only the second remains a
  // survivor, and it must keep its original ordinal-1 key (k1), not fall back to k0.
  const firstKilled = buildFindings(
    report({
      'packages/data-schemas/src/example.js': {
        source,
        language: 'javascript',
        mutants: [
          mutant({
            id: '1',
            status: 'Killed',
            location: { start: { line: 1, column: 8 }, end: { line: 1, column: 12 } },
          }),
          mutant({
            id: '2',
            status: 'Survived',
            location: { start: { line: 2, column: 8 }, end: { line: 2, column: 12 } },
          }),
        ],
      },
    }),
    plan,
    META,
  );
  assert.equal(firstKilled.findings.length, 1);
  assert.equal(firstKilled.findings[0]!.key, k1);
  assert.notEqual(firstKilled.findings[0]!.key, k0);
});

test('ordinals are computed over the full plan: an unfinished earlier identical mutant must not shift a later survivor onto its key', () => {
  const plan: ShardPlan = {
    base: BASE,
    head: HEAD,
    workspace: 'data-schemas',
    digest: 'digest',
    staticMutants: true,
    shards: [
      {
        index: 1,
        targets: [
          {
            file: 'packages/data-schemas/src/example.js',
            mutate: [],
            suppressions: [],
            functions: [
              {
                function: 'example',
                line: 1,
                column: 1,
                location: { start: { line: 1, column: 1 }, end: { line: 3, column: 1 } },
              },
            ],
          },
        ],
        expected: [],
      },
    ],
  };
  const source = 'return true;\nreturn true;\n';
  const locationA = { start: { line: 1, column: 8 }, end: { line: 1, column: 12 } };
  const locationB = { start: { line: 2, column: 8 }, end: { line: 2, column: 12 } };

  // Complete run: both identical mutants survive. A (earlier, ordinal 0) and B (later, ordinal 1)
  // get distinct keys.
  const complete = buildFindings(
    report({
      'packages/data-schemas/src/example.js': {
        source,
        language: 'javascript',
        mutants: [
          mutant({ id: 'a', status: 'Survived', location: locationA }),
          mutant({ id: 'b', status: 'Survived', location: locationB }),
        ],
      },
    }),
    plan,
    META,
  );
  assert.equal(complete.findings.length, 2);
  const keyBInComplete = complete.findings.find((finding) => finding.line === 2)!.key;

  // Partial run: A never finished (represented as a `Pending` stub, same as run.mts's
  // reconstruction), B survived. The ordinal sequence must still count A's slot, so B keeps the
  // same ordinal-1 key it would get in a complete run, instead of sliding onto A's ordinal-0 key.
  const partial = buildFindings(
    report({
      'packages/data-schemas/src/example.js': {
        source,
        language: 'javascript',
        mutants: [
          mutant({ id: 'a', status: 'Pending', location: locationA }),
          mutant({ id: 'b', status: 'Survived', location: locationB }),
        ],
      },
    }),
    plan,
    META,
  );
  assert.equal(partial.findings.length, 1);
  assert.equal(partial.findings[0]!.key, keyBInComplete);
});

test('invalidMutants lists CompileError and RuntimeError mutants with location, mutator, code, and reason', () => {
  const data = report({
    'a.js': {
      source: 'return true;\nreturn true;\n',
      language: 'javascript',
      mutants: [
        mutant({ id: '1', status: 'Killed' }),
        mutant({
          id: '2',
          status: 'RuntimeError',
          statusReason: 'TypeError: Cannot read properties of undefined',
          location: { start: { line: 1, column: 8 }, end: { line: 1, column: 12 } },
        }),
        mutant({
          id: '3',
          status: 'CompileError',
          statusReason: 'Unexpected token',
          location: { start: { line: 2, column: 8 }, end: { line: 2, column: 12 } },
        }),
      ],
    },
  });
  const invalid = invalidMutants(data);
  assert.equal(invalid.length, 2);
  assert.equal(invalid[0]!.status, 'RuntimeError');
  assert.equal(invalid[0]!.line, 1);
  assert.equal(invalid[0]!.original, 'true');
  assert.equal(invalid[0]!.reason, 'TypeError: Cannot read properties of undefined');
  assert.equal(invalid[1]!.status, 'CompileError');
  assert.equal(invalid[1]!.reason, 'Unexpected token');
});

test('buildFindings excludes RuntimeError and CompileError from both findings and detected, but still reserves their ordinal slot', () => {
  const plan: ShardPlan = {
    base: BASE,
    head: HEAD,
    workspace: 'data-schemas',
    digest: 'digest',
    staticMutants: true,
    shards: [
      {
        index: 1,
        targets: [
          {
            file: 'packages/data-schemas/src/example.js',
            mutate: [],
            suppressions: [],
            functions: [
              {
                function: 'example',
                line: 1,
                column: 1,
                location: { start: { line: 1, column: 1 }, end: { line: 3, column: 1 } },
              },
            ],
          },
        ],
        expected: [],
      },
    ],
  };
  const source = 'return true;\nreturn true;\nreturn true;\n';
  const locationA = { start: { line: 1, column: 8 }, end: { line: 1, column: 12 } };
  const locationB = { start: { line: 2, column: 8 }, end: { line: 2, column: 12 } };
  const locationC = { start: { line: 3, column: 8 }, end: { line: 3, column: 12 } };
  const data = report({
    'packages/data-schemas/src/example.js': {
      source,
      language: 'javascript',
      mutants: [
        mutant({ id: 'a', status: 'RuntimeError', location: locationA }),
        mutant({ id: 'b', status: 'Survived', location: locationB }),
        mutant({ id: 'c', status: 'Survived', location: locationC }),
      ],
    },
  });
  const findings = buildFindings(data, plan, META);
  // Only the two real survivors are findings; the RuntimeError mutant is never one.
  assert.equal(findings.findings.length, 2);
  assert.ok(findings.findings.every((finding) => finding.status === 'Survived'));
  assert.ok(findings.detected.length === 0);
  // A's RuntimeError still took ordinal 0 for this (file, mutator, original, replacement,
  // function) tuple, so B (ordinal 1) and C (ordinal 2) must not collapse onto ordinal 0/1 as
  // if A had never been reported at all.
  const keyAt = (line: number) => findings.findings.find((finding) => finding.line === line)!.key;
  const complete = buildFindings(
    report({
      'packages/data-schemas/src/example.js': {
        source,
        language: 'javascript',
        mutants: [
          mutant({ id: 'a', status: 'Survived', location: locationA }),
          mutant({ id: 'b', status: 'Survived', location: locationB }),
          mutant({ id: 'c', status: 'Survived', location: locationC }),
        ],
      },
    }),
    plan,
    META,
  );
  const completeKeyAt = (line: number) =>
    complete.findings.find((finding) => finding.line === line)!.key;
  assert.equal(keyAt(2), completeKeyAt(2));
  assert.equal(keyAt(3), completeKeyAt(3));
});

test('renderMarkdown keeps the Invalid mutants section between No coverage and Status, and the scores exclude invalid mutants', () => {
  const data = report({
    'a.js': {
      source: 'return true;\nreturn true;\n',
      language: 'javascript',
      mutants: [
        mutant({ id: '1', status: 'Killed' }),
        mutant({
          id: '2',
          status: 'RuntimeError',
          statusReason: 'crashed while the test file loaded',
          location: { start: { line: 2, column: 1 }, end: { line: 2, column: 5 } },
        }),
      ],
    },
  });
  const markdown = renderMarkdown({
    workspace: 'data-schemas',
    report: data,
    findings: { schema: 'quality-findings/v1', ...META, findings: [], detected: [] },
    suppressions: [],
  });
  const noCoverageIndex = markdown.indexOf('### No coverage');
  const invalidIndex = markdown.indexOf('### Invalid mutants');
  const statusIndex = markdown.indexOf('### Status');
  assert.ok(noCoverageIndex > 0 && invalidIndex > noCoverageIndex && statusIndex > invalidIndex);
  assert.match(markdown, /crashed while the test file loaded/);
  assert.match(markdown, /\| Invalid \| 1 \|/);
  // One Killed, one RuntimeError (excluded): both scores are 100%, not N/A, and the RuntimeError
  // mutant never lowers or hides them.
  assert.match(
    markdown,
    /Killed by assertion: Killed\/\(Killed\+Survived\+NoCoverage\) = 100\.00%/,
  );
  assert.match(markdown, /Stryker mutation score \(counts timeouts as detected\): 100\.00%/);
});

test('renderMarkdown never folds Timeout into Killed and labels the Stryker score explicitly', () => {
  const data = report({
    'a.js': {
      source: '',
      language: 'javascript',
      mutants: [mutant({ id: '1', status: 'Killed' }), mutant({ id: '2', status: 'Timeout' })],
    },
  });
  const markdown = renderMarkdown({
    workspace: 'data-schemas',
    report: data,
    findings: { schema: 'quality-findings/v1', ...META, findings: [], detected: [] },
    suppressions: [],
  });
  assert.match(markdown, /\| Killed \| 1 \|/);
  assert.match(markdown, /\| Timeout \| 1 \|/);
  assert.match(markdown, /Stryker mutation score \(counts timeouts as detected\)/);
  assert.match(markdown, /Killed by assertion: Killed\/\(Killed\+Survived\+NoCoverage\)/);
  // Neutral wording: survivors are described as not detected, never affirmatively as bugs.
  assert.match(markdown, /not detected by tests/iu);
  assert.doesNotMatch(markdown, /\bis a bug\b|\bconfirmed bug\b(?!s)/iu);
});

test('renderMarkdown labels a partial run’s scores instead of a misleading percentage', () => {
  const data = report({
    'a.js': {
      source: '',
      language: 'javascript',
      mutants: [mutant({ id: '1', status: 'Killed' }), mutant({ id: '2', status: 'Survived' })],
    },
  });
  const markdown = renderMarkdown({
    workspace: 'data-schemas',
    report: data,
    findings: {
      schema: 'quality-findings/v1',
      ...META,
      status: 'partial',
      findings: [],
      detected: [],
    },
    suppressions: [],
    totalExpected: 10,
    unfinished: [
      { file: 'a.js', location: mutant().location, mutatorName: 'BooleanLiteral' },
      { file: 'a.js', location: mutant().location, mutatorName: 'BooleanLiteral' },
    ],
  });
  const scoreLines = markdown
    .split('\n')
    .filter(
      (line) => line.startsWith('Killed by assertion') || line.startsWith('Stryker mutation score'),
    );
  assert.equal(scoreLines.length, 2);
  for (const line of scoreLines) {
    assert.match(line, /partial — 2 of 10 mutants run/);
    assert.doesNotMatch(line, /\d+\.\d\d%/);
  }
});

test('codeCell fences a value containing backticks with a longer run, padding only when needed, and escapes pipes', () => {
  assert.equal(codeCell('a'), '`a`');
  assert.equal(codeCell('a`b'), '``a`b``');
  assert.equal(codeCell('``already fenced``'), '``` ``already fenced`` ```');
  assert.equal(codeCell('a|b'), '`a\\|b`');
});

test('codeCell truncates a long value without splitting a surrogate pair', () => {
  const withEmoji = 'a'.repeat(295) + '\u{1F600}' + 'a'.repeat(20);
  const cell = codeCell(withEmoji);
  const inner = cell.slice(1, -1);
  assert.ok(inner.length <= 300);
  const lonelySurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
  assert.ok(!lonelySurrogate.test(inner));
});
