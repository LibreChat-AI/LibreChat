import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { strict as assert } from 'node:assert';

import type { Finding, QualityFindings, RiskFunction, RiskSection } from './findings.mts';

import {
  allocate,
  codeBlock,
  codeSpan,
  encodePath,
  escapeHtml,
  invalidReason,
  renderSections,
  resolveHints,
  resolveThreshold,
  safeLink,
  row,
} from './render.mts';
import { SCHEMA, unavailableMutation, unavailableRisk, validateFindings } from './findings.mts';

const HEAD = 'b'.repeat(40);
const OPTIONS = {
  repositoryUrl: 'https://github.com/owner/repo',
  head: HEAD,
  budget: Infinity,
  hints: 10,
};

const fn = (index: number, crap: number | null = 100 - index): RiskFunction => ({
  file: 'packages/api/src/a.ts',
  name: `fn${index}`,
  line: index + 1,
  column: 0,
  complexity: 3,
  cognitiveComplexity: 2,
  coverage: crap === null ? null : 0.5,
  crap,
  state: crap === null ? 'unavailable' : 'measured',
});

const riskSection = (functions: RiskFunction[]): RiskSection => ({
  workspace: 'api',
  status: 'complete',
  coverageScope: 'packages/api tests',
  summary: { files: 2, measured: 1, incomplete: 1, unavailable: 0, uncoveredLines: 3 },
  files: [
    {
      file: 'packages/api/src/a.ts',
      state: 'measured',
      scope: 'packages/api tests',
      reasons: [],
      gaps: [{ start: 4, end: 6, excerpt: 'if (x) {\n  y();\n}' }],
    },
    {
      file: 'packages/api/src/b.ts',
      state: 'incomplete',
      scope: 'packages/api tests',
      reasons: ['source map missing'],
      gaps: [],
    },
  ],
  functions,
  omitted: { files: 0, functions: 0 },
  failure: null,
});

const finding = (line: number, rank: number, original = 'a > b'): Finding => ({
  key: createHash('sha256').update(`${line}-${rank}-${original}`).digest('hex'),
  file: 'packages/data-schemas/src/x.js',
  line,
  column: 1,
  endLine: line,
  endColumn: 5,
  mutator: 'EqualityOperator',
  original,
  replacement: 'a >= b',
  source: `  if (${original}) {`,
  mutated: '  if (a >= b) {',
  status: 'Survived',
  rank,
  tags: ['behavior'],
  reason: 'Survived',
});

const data = (findings: Finding[], functions: RiskFunction[] = [fn(0)]): QualityFindings => ({
  schema: SCHEMA,
  repository: 'owner/repo',
  pr: 1,
  base: 'a'.repeat(40),
  head: HEAD,
  risk: [riskSection(functions)],
  mutation: [
    {
      ...unavailableMutation(),
      status: 'complete',
      counts: {
        killed: 5,
        survived: findings.length,
        timeout: 0,
        noCoverage: 1,
        invalid: 1,
        ignored: 0,
        pending: 0,
      },
      scores: { killedByAssertion: 50, stryker: 50 },
      findings,
      invalid: [
        {
          file: 'packages/data-schemas/src/x.js',
          line: 9,
          column: 2,
          mutator: 'BlockStatement',
          original: '{ a }',
          replacement: '{}',
          status: 'RuntimeError',
          reason: 'TypeError',
        },
      ],
      noCoverage: [{ file: 'packages/data-schemas/src/x.js', ranges: [{ start: 12, end: 14 }] }],
    },
  ],
});

test('escaping helpers keep untrusted text inside code, HTML text and https links', () => {
  assert.equal(codeSpan('a`b'), '``a`b``');
  assert.equal(codeSpan('`x`'), '`` `x` ``');
  // Pipes stay as they are outside a table; `row` escapes them only inside table cells.
  assert.equal(codeSpan('a|b\nc\u0007'), '`a|b?c?`');
  assert.equal(row([codeSpan('a||b'), 2, 'x']), '| `a\\|\\|b` | 2 | x |');
  assert.equal(codeSpan('@team ping'), '`@team ping`');
  assert.equal(codeBlock('```\nx'), '````\n```\nx\n````');
  assert.equal(escapeHtml('</summary><img src=x>'), '&lt;/summary&gt;&lt;img src=x&gt;');
  assert.equal(safeLink('javascript:alert(1)'), undefined);
  assert.equal(safeLink('http://example.com'), undefined);
  assert.equal(safeLink('https://example.com/a(b)'), 'https://example.com/a%28b%29');
  assert.equal(encodePath('src/a b/(x)#.ts'), 'src/a%20b/%28x%29%23.ts');
});

test('resolveHints accepts integers in range and falls back to the default otherwise', () => {
  assert.equal(resolveHints(undefined), 10);
  assert.equal(resolveHints(''), 10);
  assert.equal(resolveHints('0'), 0);
  assert.equal(resolveHints('25'), 25);
  for (const raw of ['-1', '101', '2.5', 'ten']) assert.equal(resolveHints(raw), 10, raw);
});

test('allocate renders small slots in full and cuts the large one to the remaining budget', () => {
  const slot = (total: number, size: number) => ({
    total,
    render: (count: number) => 'x'.repeat(count * size),
  });
  const slots = [slot(2, 10), slot(100, 10), slot(3, 10)];
  const counts = allocate(slots, 300);
  assert.deepEqual(counts, [2, 25, 3]);
  const used = slots.reduce((total, item, index) => total + item.render(counts[index]).length, 0);
  assert.ok(used <= 300);
  assert.deepEqual(allocate(slots, Infinity), [2, 100, 3]);
  assert.deepEqual(allocate(slots, 0), [0, 0, 0]);
});

test('renderSections lays out change risk, refactor hints and mutation survivors', () => {
  const findings = [
    finding(3, 41),
    finding(3, 1, 'isAdmin'),
    finding(3, 41, 'c'),
    finding(3, 41, 'd'),
    finding(3, 41, 'e'),
    finding(7, 6),
  ];
  const functions = Array.from({ length: 13 }, (_, index) => fn(index));
  functions.push(fn(13, null));
  const input = data(findings, functions);
  const checked = validateFindings(input);
  assert.equal(checked.ok, true, JSON.stringify(checked));
  const text = renderSections(input, OPTIONS);
  assert.match(text, /^#### Change risk\n/u);
  assert.match(text, /\| api \| 1 of 2 \| 1 \| 0 \| 3 \| 100\.0 \|/u);
  assert.match(text, /<details><summary>Incomplete or unavailable files \(1\)<\/summary>/u);
  assert.match(
    text,
    /- \*\*incomplete\*\* in api: `source map missing`\n {2}- `packages\/api\/src\/b\.ts`/u,
  );
  assert.match(
    text,
    /\[Lines 4-6\]\(https:\/\/github\.com\/owner\/repo\/blob\/b{40}\/packages\/api\/src\/a\.ts#L4-L6\)/u,
  );
  // Ten hints in the table, the other four folded, the unmeasured function last.
  const [shown, folded] = text.split('<details><summary>4 more functions</summary>');
  assert.equal(shown.match(/^\| `fn\d+` \|/gmu)?.length, 10);
  assert.match(folded, /\| `fn13` \| 3 \| unavailable \| unavailable \|/u);
  assert.match(text, /CRAP = complexity² × \(1 − coverage\)³ \+ complexity/u);
  assert.match(text, /#### Mutation testing/u);
  assert.match(
    text,
    /\| data-schemas \| 5 \| 6 \| 0 \| 1 \| 1 \| 0 \| 50\.0% \(Stryker 50\.0%\) \| complete \|/u,
  );
  // Line 3 holds the top-ranked survivor, so it leads; three shown in one diff, then a count.
  assert.ok(
    text.includes(
      [
        '<code>packages/data-schemas/src/x.js</code>: 6 survivors on 2 lines</summary>',
        '',
        '[Line 3](https://github.com/owner/repo/blob/' +
          HEAD +
          '/packages/data-schemas/src/x.js#L3) · behavior · 5 survivors',
        '',
        '```diff',
        '-  if (isAdmin) {',
        '@@ EqualityOperator @@',
        '+  if (a >= b) {',
        '@@ EqualityOperator @@',
        '-  if (a > b) {',
        '+  if (a >= b) {',
        '@@ EqualityOperator @@',
        '-  if (c) {',
        '+  if (a >= b) {',
        '```',
        '',
        '_2 more survivors on this line in report.md._',
        '',
        '[Line 7](https://github.com/owner/repo/blob/' +
          HEAD +
          '/packages/data-schemas/src/x.js#L7) · behavior · 1 survivor',
        '',
        '```diff',
        '-  if (a > b) {',
        '+  if (a >= b) {',
        '```',
      ].join('\n'),
    ),
    text,
  );
  assert.doesNotMatch(text, /⏎/u);
  // report.md shows every survivor on the line and no per-line count.
  const all = renderSections(input, { ...OPTIONS, survivorsPerLine: Infinity });
  assert.equal(all.match(/^@@ EqualityOperator @@$/gmu)?.length, 5);
  assert.doesNotMatch(all, /on this line in report\.md/u);
  assert.match(text, /Changed lines that no test executed during mutation testing \(1 range\)/u);
  assert.match(text, /Invalid mutants, excluded from the score \(1\)/u);
  assert.doesNotMatch(text, /more (survivors|functions|ranges|files|mutants) in report\.md/u);
});

test('renderSections cuts lists by rank to the budget and says how many were left out', () => {
  const findings = Array.from({ length: 400 }, (_, index) => finding(index + 1, index + 1));
  const functions = Array.from({ length: 200 }, (_, index) => fn(index));
  const input = data(findings, functions);
  const full = renderSections(input, OPTIONS);
  const budget = 8000;
  const text = renderSections(input, { ...OPTIONS, budget });
  assert.ok(full.length > budget);
  assert.ok(text.length <= budget, `${text.length} > ${budget}`);
  assert.match(text, /_\d+ more survivors in report\.md\._/u);
  assert.match(text, /_\d+ more functions in report\.md\._/u);
  // The best-ranked survivor and the highest CRAP function survive the cut.
  assert.match(text, /\[Line 1\]\(/u);
  // The cut count is exact: shown survivors plus the counted rest equal the total.
  const shown = text.match(/^\[Line \d+\]/gmu)?.length ?? 0;
  const rest = Number(/_(\d+) more survivors in report\.md\._/u.exec(text)?.[1]);
  assert.ok(shown > 0);
  assert.equal(shown + rest, 400);
  assert.match(text, /\| `fn0` \|/u);
  assert.match(text, /#### Mutation testing/u);
});

test('renderSections escapes hostile paths, code and reasons', () => {
  const hostile = 'packages/data-schemas/src/</summary><b>x</b>@admin.js';
  const evil: Finding = {
    ...finding(2, 1, '`x` @maintainers <img src=x onerror=alert(1)>'),
    file: hostile,
    replacement: '```\n## Heading',
    source: '  run(`x` @maintainers <img src=x onerror=alert(1)>)\u0007\r',
    mutated: '  run(```\n## Heading\n</details>)',
  };
  const input = data([evil]);
  input.risk[0].files[1].reasons = ['</details> @team'];
  const text = renderSections(input, OPTIONS);
  // Raw HTML only ever appears inside a code span, never in a <summary>.
  assert.doesNotMatch(text, /<summary>[^\n]*<\/summary><b>/u);
  assert.match(text, /most are in `packages\/data-schemas\/src\/<\/summary><b>x<\/b>@admin\.js`/u);
  assert.match(
    text,
    /<code>packages\/data-schemas\/src\/&lt;\/summary&gt;&lt;b&gt;x&lt;\/b&gt;@admin\.js<\/code>/u,
  );
  // Code stays inside a diff fence longer than its own backtick runs; control characters become ?.
  assert.ok(
    text.includes(
      [
        '````diff',
        '-  run(`x` @maintainers <img src=x onerror=alert(1)>)??',
        '+  run(```',
        '+## Heading',
        '+</details>)',
        '````',
      ].join('\n'),
    ),
    text,
  );
  assert.match(text, /`<\/details> @team`/u);
  assert.match(
    text,
    /blob\/b{40}\/packages\/data-schemas\/src\/%3C\/summary%3E%3Cb%3Ex%3C\/b%3E%40admin\.js#L2/u,
  );
});

test('a multi-line survivor shows its whole lines; one with other lines repeats its own', () => {
  const block: Finding = {
    ...finding(4, 1),
    endLine: 6,
    mutator: 'ObjectLiteral',
    tags: ['data-loss'],
    source: '  const update = {\n    $set: { role },\n  };',
    mutated: '  const update = {};',
  };
  const single: Finding = { ...finding(4, 2), source: '  const update = {' };
  const text = renderSections(data([block, single]), OPTIONS);
  assert.ok(
    text.includes(
      [
        '[Lines 4-6](https://github.com/owner/repo/blob/' +
          HEAD +
          '/packages/data-schemas/src/x.js#L4-L6) · data-loss, behavior · 2 survivors',
        '',
        '```diff',
        '-  const update = {',
        '-    $set: { role },',
        '-  };',
        '@@ ObjectLiteral @@',
        '+  const update = {};',
        '@@ EqualityOperator @@',
        '-  const update = {',
        '+  if (a >= b) {',
        '```',
      ].join('\n'),
    ),
    text,
  );
});

test('a survivor line with a backtick run gets a longer fence', () => {
  const ticks: Finding = {
    ...finding(2, 1),
    source: '  const md = `````;',
    mutated: '  const md = ``;',
  };
  const text = renderSections(data([ticks]), OPTIONS);
  assert.match(text, /\n``````diff\n- {2}const md = `````;\n\+ {2}const md = ``;\n``````\n/u);
});

test('renderSections shows unavailable workspaces without lists', () => {
  const input: QualityFindings = {
    ...data([]),
    risk: [unavailableRisk('server')],
    mutation: [unavailableMutation()],
  };
  const text = renderSections(input, OPTIONS);
  assert.match(text, /\| server \| report unavailable \|/u);
  assert.match(text, /\| data-schemas \| \| \| \| \| \| \| \| unavailable \|/u);
  assert.doesNotMatch(text, /<details>/u);
});

test('renderSections shows a failed workspace with its failing tests, escaped', () => {
  const failed: RiskSection = {
    ...unavailableRisk('api'),
    status: 'failed',
    failure: {
      failedTests: 12,
      failedSuites: 1,
      tests: [
        { suite: 'packages/api/src/a|b.spec.ts', test: '</details> `x` @team\n## Heading' },
        { suite: 'packages/api/src/broken.spec.ts', test: null },
      ],
    },
  };
  const input: QualityFindings = {
    ...data([]),
    risk: [failed, unavailableRisk('server')],
    mutation: [],
  };
  assert.equal(validateFindings(input).ok, true);
  const text = renderSections(input, OPTIONS);
  assert.match(text, /\| api \| failed: 12 tests failed, 1 suite failed to run \| \| \| \| \|\n/u);
  assert.match(text, /\| server \| report unavailable \| \| \| \| \|\n/u);
  assert.match(text, /1 workspace report unavailable; 1 workspace with failing tests/u);
  assert.match(text, /<details><summary>Failing tests<\/summary>/u);
  assert.match(
    text,
    /- api: `packages\/api\/src\/a\|b\.spec\.ts` › ``<\/details> `x` @team\?## Heading``\n/u,
  );
  assert.match(text, /- api: `packages\/api\/src\/broken\.spec\.ts` › suite failed to run/u);
  assert.match(text, /_11 more failures in the job log\._/u);
  assert.equal(text.match(/<\/details>\n/gu)?.length, 1, 'a test name cannot close the fold');
});

test('resolveThreshold accepts integers in range and falls back to the default otherwise', () => {
  assert.equal(resolveThreshold(undefined), 30);
  assert.equal(resolveThreshold(' '), 30);
  assert.equal(resolveThreshold('0'), 0);
  assert.equal(resolveThreshold('45'), 45);
  for (const raw of ['-1', '10001', '2.5', 'high']) assert.equal(resolveThreshold(raw), 30, raw);
});

test('invalidReason keeps the first error line with repository-relative paths', () => {
  const root = '/home/runner/work/LibreChat/LibreChat/source/';
  const raw = `\nmodel.x is not a function TypeError: model.x is not a function\n    at f (${root}.stryker-tmp/sandbox-sYJd6h/packages/a.ts:1:2)`;
  assert.equal(invalidReason(raw), 'TypeError: model.x is not a function');
  assert.equal(
    invalidReason(`Cannot find ${root}.stryker-tmp/sandbox-Ab1/packages/b.ts\nstack`),
    'Cannot find packages/b.ts',
  );
  assert.equal(
    invalidReason('Cannot load /__w/repo/repo/packages/c.ts'),
    'Cannot load packages/c.ts',
  );
  assert.equal(invalidReason('\n \n'), '');
  const input = data([]);
  input.mutation[0].invalid[0].reason = `${'x'.repeat(300)}\nsecond line`;
  const text = renderSections(input, OPTIONS);
  assert.match(text, /\| `x+…\[truncated\]` \|/u);
  assert.doesNotMatch(text, /second line|x\?/u);
});

test('refactor hints fold only functions at or above the CRAP threshold and count the rest', () => {
  const functions = [
    ...Array.from({ length: 10 }, (_, index) => fn(index)),
    ...Array.from({ length: 5 }, (_, index) => fn(10 + index, 50)),
    ...Array.from({ length: 4 }, (_, index) => fn(15 + index, 10)),
  ];
  const text = renderSections(data([], functions), { ...OPTIONS, threshold: 30 });
  const [shown, folded] = text.split('<details><summary>5 more functions with CRAP ≥ 30</summary>');
  assert.equal(shown.match(/^\| `fn\d+` \|/gmu)?.length, 10);
  assert.equal(folded.match(/^\| `fn\d+` \|/gmu)?.length, 5);
  assert.doesNotMatch(folded, /`fn1[5-8]`/u);
  assert.match(
    text,
    /_4 more functions below the threshold \(or cut for size\) are in report\.md\._/u,
  );
  assert.doesNotMatch(text, /\+\d+|functions more/u);

  const one = renderSections(data([], [...functions.slice(0, 10), fn(10, null)]), {
    ...OPTIONS,
    threshold: 30,
  });
  assert.doesNotMatch(one, /with CRAP ≥/u);
  assert.match(
    one,
    /_1 more function below the threshold or without a CRAP score \(or cut for size\) is in report\.md\._/u,
  );
  // Without a threshold (report.md), every remaining function is folded.
  assert.match(
    renderSections(data([], functions), OPTIONS),
    /<summary>9 more functions<\/summary>/u,
  );
});

test('renderSections labels one line in the singular and escapes pipes only in tables', () => {
  const input = data([finding(3, 1, 'a || b')]);
  input.risk[0].files[0].gaps = [{ start: 9, end: 9, excerpt: 'x();' }];
  input.mutation[0].invalid[0].original = 'a || b';
  const text = renderSections(input, OPTIONS);
  assert.match(text, /\[Line 9\]\([^)]+#L9\)/u);
  assert.doesNotMatch(text, /Lines 9\b/u);
  assert.match(
    text,
    /\[Line 3\]\([^)]+\) · behavior · 1 survivor\n\n```diff\n-  if \(a \|\| b\) \{\n/u,
  );
  assert.match(text, /\| BlockStatement \| `a \\\|\\\| b` → `\{\}` \|/u);
});

test('takeaways summarize change risk and survivors from the data only', () => {
  const input = data([
    finding(3, 1),
    finding(4, 2),
    { ...finding(5, 3), file: 'packages/data-schemas/src/y.js' },
  ]);
  input.risk[0].summary = {
    files: 2,
    measured: 2,
    incomplete: 0,
    unavailable: 0,
    uncoveredLines: 3,
  };
  input.risk[0].files[1].state = 'measured';
  const text = renderSections(input, OPTIONS);
  assert.match(
    text,
    /#### Change risk\n\n\*\*Takeaway:\*\* 3 changed lines have no test\. Highest CRAP among changed functions: `fn0` at \[`packages\/api\/src\/a\.ts:1`\]\([^)]+#L1\), CRAP 100\.0 with 50% coverage\.\n/u,
  );
  assert.match(
    text,
    /#### Mutation testing\n\n\*\*Takeaway:\*\* 3 survivors; the most are in `packages\/data-schemas\/src\/x\.js` \(2\)\.\n/u,
  );

  input.risk[0].summary.uncoveredLines = 1;
  assert.match(renderSections(input, OPTIONS), /\*\*Takeaway:\*\* 1 changed line has no test\./u);

  // Nothing to report: no takeaway at all.
  const empty = data([], []);
  empty.risk[0].summary = {
    files: 1,
    measured: 1,
    incomplete: 0,
    unavailable: 0,
    uncoveredLines: 0,
  };
  assert.doesNotMatch(renderSections(empty, OPTIONS), /Takeaway/u);

  // Incomplete data says so instead of a summary.
  const partial = data([finding(3, 1)]);
  partial.mutation[0].status = 'partial';
  partial.risk.push(unavailableRisk('server'));
  const incomplete = renderSections(partial, OPTIONS);
  assert.match(
    incomplete,
    /\*\*Takeaway:\*\* incomplete data \(1 workspace report unavailable; 1 file without reliable coverage\), so no summary is given\./u,
  );
  assert.match(
    incomplete,
    /\*\*Takeaway:\*\* incomplete data \(1 run stopped at the budget\), so no summary is given\./u,
  );
});
