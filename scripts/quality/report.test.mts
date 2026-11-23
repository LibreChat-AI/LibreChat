import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import type { MutationReport } from './merge.mts';
import type { ShardPlan } from './shards.mts';

import {
  buildFindings,
  buildMutationSection,
  codeCell,
  ignoredBreakdown,
  invalidMutants,
  MAX_SURVIVOR_LINES,
  mutantLines,
  noCoverageRanges,
  rankOf,
  renderMarkdown,
  scores,
  statusCounts,
  tagsFor,
  topicsFor,
  words,
} from './report.mts';
import { SCHEMA, validateFindings } from './findings.mts';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const META = { planDigest: 'abc123', status: 'complete' as const };

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

test('words splits camelCase, PascalCase, acronyms, snake_case, kebab-case, paths and digits', () => {
  assert.equal(words('authorizeProviderSession'), 'authorize provider session');
  assert.equal(words('HTTPServer'), 'http server');
  assert.equal(words('refresh_token'), 'refresh token');
  assert.equal(words('user-role.id'), 'user role id');
  assert.equal(words('refreshToken2'), 'refresh token 2');
  assert.equal(words('packages/api/src/auth/index.ts'), 'packages api src auth index ts');
});

test('topicsFor matches whole identifier words with simple plural and verb suffixes', () => {
  const tagsOf = (code: string, file = 'packages/data-schemas/src/example.js') =>
    tagsFor({ original: code, replacement: 'x', functionName: 'helper', file });
  const cases: [string, string[]][] = [
    ['authorizeProviderSession', ['authorization']],
    ['isAuthorized', ['authorization']],
    ['hasPermission', ['authorization']],
    ['user.role', ['authorization']],
    ['userRole', ['authorization']],
    ['accessToken', ['credentials']],
    ['refreshToken', ['credentials']],
    ['refresh_token', ['credentials']],
    ['token', ['credentials']],
    ['tenantId', ['tenant']],
    ['tenantIds', ['tenant']],
    ['deleteSession', ['data-loss']],
    ['softDelete', ['data-loss']],
    ['expiresAt', ['credentials']],
    // `author` names who wrote a message or prompt, not who may act; it is not a keyword.
    ['authorName', ['behavior']],
    ['dropdown', ['behavior']],
    ['deleteToken', ['credentials', 'data-loss']],
  ];
  for (const [code, tags] of cases) assert.deepEqual(tagsOf(code), tags, code);
  assert.deepEqual(
    topicsFor({
      original: 'a > b',
      replacement: 'a >= b',
      functionName: 'helper',
      file: 'packages/api/src/auth/helpers.ts',
    }),
    [{ tag: 'authorization', pathOnly: true }],
  );
  // A code match wins over the same topic's path match.
  assert.deepEqual(
    topicsFor({
      original: 'isAdmin',
      replacement: 'true',
      functionName: 'helper',
      file: 'packages/api/src/auth/helpers.ts',
    }),
    [{ tag: 'authorization', pathOnly: false }],
  );
  // Emptying an object literal is code-derived data loss, whatever the path says.
  assert.deepEqual(
    topicsFor({ original: '{ a }', replacement: '{}', functionName: 'f', file: 'src/remove.js' }),
    [{ tag: 'data-loss', pathOnly: false }],
  );
});

test('rankOf orders topics by priority, puts path-only matches 5 after code matches, then mutator', () => {
  const at = (original: string, file: string, mutator = 'EqualityOperator', replacement = 'x') =>
    rankOf(
      topicsFor({ original, replacement, functionName: 'helper', file }),
      mutator,
      replacement,
    );
  const plain = 'packages/data-schemas/src/example.js';
  const codeAuth = at('isAuthorized', plain);
  const pathAuth = at('a > b', 'packages/api/src/auth/helpers.ts');
  const codeTenant = at('tenantId', plain);
  const behavior = at('a > b', plain);
  assert.equal(codeAuth, 1);
  assert.equal(pathAuth, 6);
  assert.equal(codeTenant, 11);
  assert.equal(behavior, 41);
  assert.ok(codeAuth < pathAuth && pathAuth < codeTenant && codeTenant < behavior);
  assert.equal(at('{ tenantId }', plain, 'ObjectLiteral', '{}'), 10, 'tenant beats data-loss');
  assert.equal(at('a > b', plain, 'StringLiteral'), 42);
  // Being inside a brand-new function is not an input, so the rank cannot depend on it.
  assert.equal(
    rankOf(
      topicsFor({ original: 'a > b', replacement: 'x', functionName: 'brandNew', file: plain }),
      'EqualityOperator',
      'x',
    ),
    behavior,
  );
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
  const findings = buildFindings(data, plan);
  assert.equal(findings.length, 2);
  assert.ok(findings.every((finding) => finding.status === 'Survived'));
  // Both survivors share file/mutator/original/replacement/function (identical tuple); the
  // ordinal is what tells them apart, so their keys must differ.
  const [first, second] = findings;
  assert.notEqual(first.key, second.key);
  // Each finding carries its whole source line and that line with the replacement applied.
  assert.equal(first.source, 'return true;');
  assert.equal(first.mutated, 'return false;');
  assert.equal(second.source, 'return true;');
});

test('mutantLines shows the whole spanned lines and caps their count and width', () => {
  const source = 'const a = {\r\n  role: 1,\r\n};\nx();';
  const span = { start: { line: 1, column: 11 }, end: { line: 3, column: 2 } };
  assert.deepEqual(mutantLines(source, span, '{}'), {
    source: 'const a = {\n  role: 1,\n};',
    mutated: 'const a = {};',
  });
  // A multi-line replacement keeps its own lines.
  assert.deepEqual(
    mutantLines(
      'if (a) b();',
      { start: { line: 1, column: 8 }, end: { line: 1, column: 12 } },
      '{\n}',
    ),
    { source: 'if (a) b();', mutated: 'if (a) {\n}' },
  );
  const long = Array.from({ length: 20 }, (_, index) => `${index}${'x'.repeat(200)}`).join('\n');
  const capped = mutantLines(
    long,
    { start: { line: 1, column: 1 }, end: { line: 20, column: 5 } },
    'y',
  );
  const lines = capped.source.split('\n');
  assert.equal(lines.length, MAX_SURVIVOR_LINES + 1);
  assert.equal(lines.at(-1), '… 8 more lines');
  assert.ok(lines.slice(0, -1).every((line) => line.length === 161 && line.endsWith('…')));
  assert.equal(capped.mutated, `y${'x'.repeat(159)}…`);
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
  );
  assert.equal(bothSurvived.length, 2);
  const [k0, k1] = bothSurvived.map((finding) => finding.key);
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
  );
  assert.equal(firstKilled.length, 1);
  assert.equal(firstKilled[0]!.key, k1);
  assert.notEqual(firstKilled[0]!.key, k0);
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
  );
  assert.equal(complete.length, 2);
  const keyBInComplete = complete.find((finding) => finding.line === 2)!.key;

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
  );
  assert.equal(partial.length, 1);
  assert.equal(partial[0]!.key, keyBInComplete);
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

test('buildFindings excludes RuntimeError and CompileError from findings, but still reserves their ordinal slot', () => {
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
  const findings = buildFindings(data, plan);
  // Only the two real survivors are findings; the RuntimeError mutant is never one.
  assert.equal(findings.length, 2);
  assert.ok(findings.every((finding) => finding.status === 'Survived'));
  // A's RuntimeError still took ordinal 0 for this (file, mutator, original, replacement,
  // function) tuple, so B (ordinal 1) and C (ordinal 2) must not collapse onto ordinal 0/1 as
  // if A had never been reported at all.
  const keyAt = (line: number) => findings.find((finding) => finding.line === line)!.key;
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
  );
  const completeKeyAt = (line: number) => complete.find((finding) => finding.line === line)!.key;
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
    status: 'complete',
    findings: [],
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
    status: 'complete',
    findings: [],
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
    status: 'partial',
    findings: [],
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

test('buildMutationSection carries counts, ignored reasons, scores, survivors, invalid and no-coverage data', () => {
  const plan: ShardPlan = {
    base: BASE,
    head: HEAD,
    workspace: 'data-schemas',
    digest: 'digest',
    staticMutants: true,
    shards: [{ index: 1, targets: [], expected: [] }],
  };
  const data = report({
    'a.js': {
      source: 'return true;\nreturn true;\nreturn true;\n',
      language: 'javascript',
      mutants: [
        mutant({ id: '1', status: 'Killed' }),
        mutant({ id: '2', status: 'Survived' }),
        mutant({ id: '3', status: 'Timeout' }),
        mutant({
          id: '4',
          status: 'NoCoverage',
          location: { start: { line: 2, column: 1 }, end: { line: 2, column: 5 } },
        }),
        mutant({ id: '5', status: 'RuntimeError', statusReason: 'crash' }),
        mutant({ id: '6', status: 'Ignored', statusReason: 'Static mutant' }),
        mutant({ id: '7', status: 'Pending' }),
      ],
    },
  });
  const section = buildMutationSection(data, plan, META);
  assert.deepEqual(section.counts, {
    killed: 1,
    survived: 1,
    timeout: 1,
    noCoverage: 1,
    invalid: 1,
    ignored: 1,
    pending: 1,
  });
  assert.deepEqual(section.ignored, [{ reason: 'static', count: 1 }]);
  assert.equal(section.scores.killedByAssertion, (100 * 1) / 3);
  assert.equal(section.scores.stryker, (100 * 2) / 4);
  assert.equal(section.findings.length, 1);
  assert.equal(section.invalid[0].reason, 'crash');
  assert.deepEqual(section.noCoverage, [{ file: 'a.js', ranges: [{ start: 2, end: 2 }] }]);
  const document = {
    schema: SCHEMA,
    repository: 'owner/repo',
    pr: 1,
    base: BASE,
    head: HEAD,
    risk: [],
    mutation: [section],
  };
  assert.equal(validateFindings(document).ok, true);
  const partial = buildMutationSection(data, plan, { ...META, status: 'partial' });
  assert.deepEqual(partial.scores, { killedByAssertion: null, stryker: null });
  assert.equal(partial.status, 'partial');
});
