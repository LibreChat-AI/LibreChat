import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';

import type { API, Context, Request } from './comment.mts';
import type {
  ExistingComment,
  Finding,
  PullFile,
  QualityFindings,
  ReviewSummary,
  StaleScope,
  WorkflowRun,
} from './inline.mts';

import { renderRequest } from './comment.mts';
import {
  bindToDiff,
  fence,
  FINDINGS_UPLOAD_STEP,
  loadFindingsFile,
  markStale,
  mutationReportRan,
  parseMarker,
  planComments,
  publishInline,
  renderBody,
  renderReviewBody,
  resolveLimit,
  safeLink,
  reviewComments,
  updateMarkerHead,
  validateFindings,
} from './inline.mts';

const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const otherHead = 'c'.repeat(40);
const defaultBranchHead = 'e'.repeat(40);
const file = 'packages/data-schemas/src/methods/user.ts';
const expected = { repository: 'owner/repo', pr: 1, base, head };
const noStale: StaleScope | undefined = undefined;
const staleScope = (files: string[], detected: string[] = []): StaleScope => ({
  mutatedFiles: new Set(files),
  patchedFiles: new Set(files),
  detected: new Set(detected),
});

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    key: 'a'.repeat(64),
    file,
    line: 6,
    column: 3,
    endLine: 7,
    endColumn: 9,
    mutator: 'ObjectLiteral',
    original: '{ tenantId }',
    replacement: '{}',
    status: 'Survived',
    rank: 0,
    tags: ['tenant'],
    reason: 'Dropping tenantId was not caught by any test.',
    ...overrides,
  };
}

function makeDoc(findings: Finding[], overrides: Partial<QualityFindings> = {}): QualityFindings {
  return {
    schema: 'quality-findings/v1',
    repository: 'owner/repo',
    pr: 1,
    base,
    head,
    workspace: 'packages/data-schemas',
    planDigest: 'deadbeef',
    status: 'complete',
    findings,
    detected: [],
    omitted: 0,
    ...overrides,
  };
}

// --- resolveLimit --------------------------------------------------------

test('resolveLimit defaults to 5 and accepts the 0..20 integer range', () => {
  assert.equal(resolveLimit(undefined), 5);
  assert.equal(resolveLimit(''), 5);
  assert.equal(resolveLimit('0'), 0);
  assert.equal(resolveLimit('20'), 20);
  assert.equal(resolveLimit('3'), 3);
});

test('resolveLimit fails closed to the default on anything out of range', () => {
  for (const raw of ['-1', '21', '5.5', 'abc', '  ']) {
    assert.equal(resolveLimit(raw), 5, raw);
  }
});

// --- validateFindings ------------------------------------------------------

test('validateFindings accepts a well-formed document', () => {
  const result = validateFindings(makeDoc([makeFinding()]), expected);
  assert.equal(result.ok, true);
});

test('validateFindings rejects document-level schema variants', () => {
  const variants: Array<[string, Partial<QualityFindings>]> = [
    ['schema', { schema: 'quality-findings/v2' as never }],
    ['repository', { repository: 'other/repo' }],
    ['pr', { pr: 2 }],
    ['base', { base: 'c'.repeat(40) }],
    ['head', { head: 'c'.repeat(40) }],
    ['workspace', { workspace: 'packages/api' as never }],
    ['planDigest', { planDigest: 'not-hex' }],
    ['status', { status: 'done' as never }],
    ['reportUrl', { reportUrl: 'javascript:alert(1)' }],
    ['missing omitted', { omitted: undefined as never }],
    ['negative omitted', { omitted: -1 }],
    ['non-integer omitted', { omitted: 1.5 }],
    ['missing detected', { detected: undefined as never }],
    ['non-array detected', { detected: 'a'.repeat(64) as never }],
    ['detected key not hex', { detected: ['not-hex'] }],
    ['duplicate detected key', { detected: ['a'.repeat(64), 'a'.repeat(64)] }],
  ];
  for (const [label, override] of variants) {
    const result = validateFindings(makeDoc([makeFinding()], override), expected);
    assert.equal(result.ok, false, label);
  }
});

test('validateFindings accepts a well-formed detected list', () => {
  const result = validateFindings(
    makeDoc([makeFinding()], { detected: ['a'.repeat(64), 'b'.repeat(64)] }),
    expected,
  );
  assert.equal(result.ok, true, result.ok ? undefined : result.error);
});

test('validateFindings accepts an omitted count above the 2000-finding cap', () => {
  // omitted also counts findings dropped for exceeding the 2000-finding cap, not just the byte
  // budget, so a value above 2000 is a legitimate overflow count, not a contract violation.
  const result = validateFindings(makeDoc([makeFinding()], { omitted: 2001 }), expected);
  assert.equal(result.ok, true, result.ok ? undefined : result.error);
});

test('validateFindings accepts an unavailable artifact with an empty plan digest', () => {
  const result = validateFindings(makeDoc([], { status: 'unavailable', planDigest: '' }), expected);
  assert.equal(result.ok, true, result.ok ? undefined : result.error);
});

test('validateFindings rejects an oversize findings list', () => {
  const result = validateFindings(makeDoc(Array(2001).fill(makeFinding())), expected);
  assert.equal(result.ok, false);
});

test('validateFindings rejects finding-level schema variants, including path traversal', () => {
  const variants: Array<[string, Partial<Finding>]> = [
    ['key', { key: 'not-hex' }],
    ['path traversal', { file: '../outside.ts' }],
    ['absolute path', { file: '/etc/passwd' }],
    ['backslash path', { file: 'packages\\data-schemas\\x.ts' }],
    ['endLine before line', { line: 10, endLine: 5 }],
    ['oversize original', { original: 'x'.repeat(2001) }],
    ['oversize replacement', { replacement: 'x'.repeat(2001) }],
    ['status', { status: 'Killed' as never }],
    ['unknown tag', { tags: ['exploit'] as never }],
    ['oversize reason', { reason: 'x'.repeat(501) }],
    ['mutator with scope syntax', { mutator: '@org/team' }],
    ['mutator with markdown link', { mutator: '[x](http://evil)' }],
    ['mutator with HTML', { mutator: '<img src=x>' }],
    ['mutator with digits', { mutator: 'Block1' }],
    ['empty mutator', { mutator: '' }],
  ];
  for (const [label, override] of variants) {
    const result = validateFindings(makeDoc([makeFinding(override)]), expected);
    assert.equal(result.ok, false, label);
  }
});

// --- loadFindingsFile --------------------------------------------------------

test('loadFindingsFile treats a missing or empty directory as "no artifact", not a failure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inline-'));
  try {
    assert.deepEqual(loadFindingsFile(join(dir, 'absent')), { ok: true, value: undefined });
    assert.deepEqual(loadFindingsFile(dir), { ok: true, value: undefined });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadFindingsFile rejects extra files, the wrong filename, oversize content, and bad JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inline-'));
  try {
    writeFileSync(join(dir, 'wrong.json'), '{}');
    assert.equal(loadFindingsFile(dir).ok, false);
    rmSync(join(dir, 'wrong.json'));

    writeFileSync(join(dir, 'findings.json'), '{}');
    writeFileSync(join(dir, 'extra.json'), '{}');
    assert.equal(loadFindingsFile(dir).ok, false);
    rmSync(join(dir, 'extra.json'));

    writeFileSync(join(dir, 'findings.json'), '{not json');
    assert.equal(loadFindingsFile(dir).ok, false);

    writeFileSync(join(dir, 'findings.json'), 'x'.repeat(1_000_001));
    assert.equal(loadFindingsFile(dir).ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadFindingsFile parses a valid single findings.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inline-'));
  try {
    const doc = makeDoc([makeFinding()]);
    writeFileSync(join(dir, 'findings.json'), JSON.stringify(doc));
    const result = loadFindingsFile(dir);
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok && result.value, doc);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- bindToDiff --------------------------------------------------------------

const patch = '@@ -5,2 +5,4 @@\n context\n+added1\n+added2\n context2';
const files: PullFile[] = [{ filename: file, status: 'modified', patch }];

test('bindToDiff accepts a finding whose range lies on the RIGHT side of a hunk', () => {
  const bound = bindToDiff([makeFinding({ line: 6, endLine: 7 })], files);
  assert.equal(bound.length, 1);
});

test('bindToDiff skips a finding outside every hunk range', () => {
  const bound = bindToDiff([makeFinding({ line: 50, endLine: 50 })], files);
  assert.equal(bound.length, 0);
});

test('bindToDiff skips a finding whose file is not in the PR', () => {
  const bound = bindToDiff([makeFinding({ file: 'packages/data-schemas/src/other.ts' })], files);
  assert.equal(bound.length, 0);
});

test('bindToDiff skips a finding in a file with no patch (binary or too large)', () => {
  const bound = bindToDiff([makeFinding()], [{ filename: file, status: 'modified' }]);
  assert.equal(bound.length, 0);
});

test('bindToDiff binds a multi-line range that lies entirely on context lines of one hunk', () => {
  const contextOnly = '@@ -5,3 +5,3 @@\n ctx5\n ctx6\n ctx7';
  const bound = bindToDiff(
    [makeFinding({ line: 5, endLine: 7 })],
    [{ filename: file, status: 'modified', patch: contextOnly }],
  );
  assert.equal(bound.length, 1);
  assert.equal(bound[0].line, 5);
  assert.equal(bound[0].endLine, 7);
});

test('bindToDiff anchors a range crossing a hunk boundary at its first added line', () => {
  const crossing =
    '@@ -5,2 +5,3 @@\n ctx5\n+add6\n ctx7\n@@ -20,2 +20,3 @@\n ctx20\n+add21\n ctx22';
  const bound = bindToDiff(
    [makeFinding({ line: 6, endLine: 21 })],
    [{ filename: file, status: 'modified', patch: crossing }],
  );
  assert.equal(bound.length, 1);
  assert.equal(bound[0].line, 6);
  assert.equal(bound[0].endLine, 6);
});

test('bindToDiff skips a range crossing a hunk boundary with no added line inside it', () => {
  const crossing =
    '@@ -5,2 +5,3 @@\n ctx5\n+add6\n ctx7\n@@ -20,2 +20,3 @@\n ctx20\n+add21\n ctx22';
  const bound = bindToDiff(
    [makeFinding({ line: 7, endLine: 20 })],
    [{ filename: file, status: 'modified', patch: crossing }],
  );
  assert.equal(bound.length, 0);
});

// --- fence / rendering ---------------------------------------------------

test('fence returns a run longer than any backtick run in the content', () => {
  assert.equal(fence('no backticks here'), '```');
  assert.equal(fence('has ``` three backticks'), '````');
  assert.equal(fence('has ```` four backticks'), '`````');
});

test('renderBody embeds a marker, uses neutral wording, and fences unsafe content', () => {
  const finding = makeFinding({ original: 'has ``` backticks' });
  const body = renderBody(finding, head);
  assert.equal(parseMarker(body)?.key, finding.key);
  assert.equal(parseMarker(body)?.head, head);
  assert.equal(parseMarker(body)?.posted, head);
  assert.match(body, /survived the tests at [a-f0-9]{7}/u);
  assert.doesNotMatch(body, /\bbug\b/iu);
  assert.ok(body.includes('````'));
});

test('renderBody never renders the artifact reason text, only fixed tag labels', () => {
  const finding = makeFinding({
    reason: 'Click here <img src=x onerror=alert(1)> or @org/team [link](http://evil)',
    tags: ['tenant'],
  });
  const body = renderBody(finding, head);
  assert.doesNotMatch(body, /@org\/team/u);
  assert.doesNotMatch(body, /<img/iu);
  assert.doesNotMatch(body, /\[link\]/u);
  assert.match(body, /Affects: tenant isolation/u);
});

test('renderBody accepts a separate posted head distinct from the current head', () => {
  const body = renderBody(makeFinding(), head, otherHead);
  assert.deepEqual(parseMarker(body), { key: 'a'.repeat(64), head, posted: otherHead });
});

// --- marker helpers --------------------------------------------------------

test('parseMarker reads only the hidden first line', () => {
  const body = renderBody(makeFinding(), head);
  assert.deepEqual(parseMarker(body), { key: 'a'.repeat(64), head, posted: head });
  assert.equal(parseMarker('no marker here'), undefined);
});

test('updateMarkerHead rewrites only the head field, leaving posted untouched', () => {
  const body = renderBody(makeFinding(), head, otherHead);
  const updated = updateMarkerHead(body, 'd'.repeat(40));
  assert.deepEqual(parseMarker(updated), {
    key: 'a'.repeat(64),
    head: 'd'.repeat(40),
    posted: otherHead,
  });
  assert.equal(updated.slice(body.indexOf('\n')), body.slice(body.indexOf('\n')));
});

test('markStale is idempotent at the same head and replaces an older stale line', () => {
  const body = renderBody(makeFinding(), head);
  const staled = markStale(body, otherHead);
  assert.equal(markStale(staled, otherHead), staled);
  const restaled = markStale(staled, 'd'.repeat(40));
  assert.equal((restaled.match(/No longer reported at/gu) ?? []).length, 1);
});

// --- planComments ------------------------------------------------------------

test('planComments posts new survivors, ranked by the artifact rank field, within the cap', () => {
  const low = makeFinding({ key: 'a'.repeat(64), rank: 1, tags: ['authorization'] });
  const high = makeFinding({ key: 'b'.repeat(64), rank: 0, tags: ['behavior'] });
  const plan = planComments([low, high], [low, high], [], 2, head, noStale);
  assert.deepEqual(
    plan.post.map((f) => f.key),
    [high.key, low.key],
  );
});

test('planComments respects the cap on new comments only', () => {
  const findings = [0, 1, 2].map((rank) =>
    makeFinding({ key: String(rank).repeat(64).slice(0, 64), rank }),
  );
  const plan = planComments(findings, findings, [], 1, head, noStale);
  assert.equal(plan.post.length, 1);
  assert.equal(plan.post[0].rank, 0);
});

test('planComments never reposts a surviving key already commented, and updates its head marker', () => {
  const finding = makeFinding();
  const existing: ExistingComment[] = [
    { id: 10, body: renderBody(finding, otherHead), path: file },
  ];
  const plan = planComments([finding], [finding], existing, 5, head, noStale);
  assert.equal(plan.post.length, 0);
  assert.equal(plan.update.length, 1);
  assert.equal(plan.update[0].id, 10);
  assert.deepEqual(parseMarker(plan.update[0].body), {
    key: finding.key,
    head,
    posted: otherHead,
  });
});

test('planComments marks a no-longer-surviving key stale when its file was mutated and patched', () => {
  const posted = makeFinding();
  const existing: ExistingComment[] = [{ id: 11, body: renderBody(posted, head), path: file }];
  const plan = planComments([], [], existing, 5, head, staleScope([file], [posted.key]));
  assert.equal(plan.markStale.length, 1);
  assert.equal(plan.markStale[0].id, 11);
  const again = planComments(
    [],
    [],
    [{ id: 11, body: plan.markStale[0].body, path: file }],
    5,
    head,
    staleScope([file], [posted.key]),
  );
  assert.equal(again.markStale.length, 0);
});

test('planComments never marks a key stale when it is missing from findings but not proven detected', () => {
  // The key could have become Ignored, NoCoverage, or invalid, or simply never run on a partial
  // shard — none of those prove the mutant was actually killed or timed out this run.
  const posted = makeFinding();
  const existing: ExistingComment[] = [{ id: 13, body: renderBody(posted, head), path: file }];
  const plan = planComments([], [], existing, 5, head, staleScope([file]));
  assert.equal(plan.markStale.length, 0);
});

test('planComments never marks a key stale when stale scope is withheld (a partial run)', () => {
  const posted = makeFinding();
  const existing: ExistingComment[] = [{ id: 40, body: renderBody(posted, head), path: file }];
  const plan = planComments([], [], existing, 5, head, noStale);
  assert.equal(plan.markStale.length, 0);
});

test('planComments does not mark a key stale when its file was not mutated this run', () => {
  const posted = makeFinding();
  const existing: ExistingComment[] = [{ id: 41, body: renderBody(posted, head), path: file }];
  const plan = planComments(
    [],
    [],
    existing,
    5,
    head,
    staleScope(['packages/data-schemas/src/other.ts']),
  );
  assert.equal(plan.markStale.length, 0);
});

test('planComments does not mark a key stale when its file has no patch', () => {
  const posted = makeFinding();
  const existing: ExistingComment[] = [{ id: 42, body: renderBody(posted, head), path: file }];
  const plan = planComments([], [], existing, 5, head, {
    mutatedFiles: new Set([file]),
    patchedFiles: new Set(),
    detected: new Set([posted.key]),
  });
  assert.equal(plan.markStale.length, 0);
});

test('planComments never marks a survivor stale when it no longer binds to the diff', () => {
  // The artifact still reports this key as a survivor; it just does not land on a diff line
  // this run (e.g. its file was not re-touched). Losing it from `bound` must not read as "gone".
  const posted = makeFinding();
  const existing: ExistingComment[] = [{ id: 43, body: renderBody(posted, head), path: file }];
  const plan = planComments([posted], [], existing, 5, head, staleScope([file]));
  assert.equal(plan.markStale.length, 0);
  assert.equal(plan.update.length, 0);
});

test('planComments ignores comments without the hidden marker', () => {
  const foreign: ExistingComment[] = [{ id: 12, body: 'Looks good to me.', path: file }];
  const finding = makeFinding();
  const plan = planComments([finding], [finding], foreign, 5, head, noStale);
  assert.equal(plan.post.length, 1);
  assert.equal(plan.update.length, 0);
  assert.equal(plan.markStale.length, 0);
});

test('planComments posts nothing when the limit is 0', () => {
  const finding = makeFinding();
  const plan = planComments([finding], [finding], [], 0, head, noStale);
  assert.equal(plan.post.length, 0);
});

test('planComments caps new posts per tested head, counting prior posts at that head', () => {
  const already = [0, 1].map((rank) => makeFinding({ key: String(rank).repeat(64), rank }));
  const existing: ExistingComment[] = already.map((finding, index) => ({
    id: 20 + index,
    body: renderBody(finding, head),
    path: file,
  }));
  const extra = makeFinding({ key: 'f'.repeat(64), rank: 2 });
  const survivors = [...already, extra];
  const plan = planComments(survivors, survivors, existing, 2, head, noStale);
  assert.equal(plan.post.length, 0);
});

test('planComments allows only the remaining per-head capacity across repeated runs', () => {
  const posted = makeFinding({ key: 'a'.repeat(64), rank: 0 });
  const existing: ExistingComment[] = [{ id: 30, body: renderBody(posted, head), path: file }];
  const extra = makeFinding({ key: 'b'.repeat(64), rank: 1 });
  const survivors = [posted, extra];
  const plan = planComments(survivors, survivors, existing, 2, head, noStale);
  assert.equal(plan.post.length, 1);
  assert.equal(plan.post[0].key, extra.key);
});

test('planComments revives a stale-marked key that survives again, stripping the stale note', () => {
  const posted = makeFinding();
  const stale = planComments(
    [],
    [],
    [{ id: 50, body: renderBody(posted, head), path: file }],
    5,
    otherHead,
    staleScope([file], [posted.key]),
  );
  assert.equal(stale.markStale.length, 1);
  const staledBody = stale.markStale[0].body;
  assert.match(staledBody, /No longer reported at/u);

  // The mutant survives again at a new head: the stale note must be removed, not left stacked.
  const revivedExisting: ExistingComment[] = [{ id: 50, body: staledBody, path: file }];
  const revived = planComments(
    [posted],
    [posted],
    revivedExisting,
    5,
    defaultBranchHead,
    staleScope([file]),
  );
  assert.equal(revived.update.length, 1);
  assert.doesNotMatch(revived.update[0].body, /No longer reported at/u);
  assert.equal(parseMarker(revived.update[0].body)?.head, defaultBranchHead);

  // Re-planning against the revived body changes nothing further (idempotent).
  const idempotent = planComments(
    [posted],
    [posted],
    [{ id: 50, body: revived.update[0].body, path: file }],
    5,
    defaultBranchHead,
    staleScope([file]),
  );
  assert.equal(idempotent.update.length, 0);
});

// --- reviewComments --------------------------------------------------------

test('reviewComments sets start_line only for a multi-line finding', () => {
  const [single] = reviewComments([makeFinding({ line: 7, endLine: 7 })], head);
  assert.equal('start_line' in single, false);
  const [multi] = reviewComments([makeFinding({ line: 6, endLine: 7 })], head);
  assert.equal(multi.start_line, 6);
  assert.equal(multi.start_side, 'RIGHT');
  assert.equal(multi.side, 'RIGHT');
});

// --- mutationReportRan --------------------------------------------------------

interface JobFixture {
  name: string;
  status: string;
  conclusion: string | null;
  id: number;
  steps?: { name: string; conclusion: string | null }[];
}
function jobsApi(jobs: JobFixture[]): API {
  return {
    async request<T>(_method: string, path: string): Promise<T> {
      assert.equal(path.split('?')[0], 'actions/runs/7/jobs');
      return { jobs } as T;
    },
  };
}
const reportJob = (steps?: JobFixture['steps']): JobFixture => ({
  name: 'Mutation report (data-schemas)',
  status: 'completed',
  conclusion: steps ? 'success' : 'failure',
  id: 1,
  steps,
});

test('mutationReportRan trusts only a report job whose own upload step succeeded', async () => {
  assert.equal(
    await mutationReportRan(
      jobsApi([reportJob([{ name: FINDINGS_UPLOAD_STEP, conclusion: 'success' }])]),
      7,
      'packages/data-schemas',
    ),
    true,
    'upload step succeeded',
  );
  assert.equal(
    await mutationReportRan(jobsApi([]), 7, 'packages/data-schemas'),
    false,
    'no matching job at all',
  );
  assert.equal(
    await mutationReportRan(jobsApi([reportJob(undefined)]), 7, 'packages/data-schemas'),
    false,
    'job failed before its own upload step ran',
  );
  assert.equal(
    await mutationReportRan(
      jobsApi([reportJob([{ name: FINDINGS_UPLOAD_STEP, conclusion: 'skipped' }])]),
      7,
      'packages/data-schemas',
    ),
    false,
    'upload step present but skipped',
  );
  assert.equal(
    await mutationReportRan(
      jobsApi([reportJob([{ name: FINDINGS_UPLOAD_STEP, conclusion: 'failure' }])]),
      7,
      'packages/data-schemas',
    ),
    false,
    'upload step present but failed',
  );
  assert.equal(
    await mutationReportRan(
      jobsApi([
        {
          name: 'Mutation report (api)',
          status: 'completed',
          conclusion: 'success',
          id: 1,
          steps: [{ name: FINDINGS_UPLOAD_STEP, conclusion: 'success' }],
        },
      ]),
      7,
      'packages/data-schemas',
    ),
    false,
    'wrong workspace in the job name',
  );
});

// --- renderReviewBody ------------------------------------------------------

const summary = (overrides: Partial<ReviewSummary> = {}): ReviewSummary => ({
  head,
  survived: 3,
  partial: false,
  limit: 5,
  reportUrl: 'https://github.com/owner/repo/actions/runs/55',
  repositoryUrl: 'https://github.com/owner/repo',
  post: [makeFinding({ line: 6, endLine: 6 }), makeFinding({ key: 'b'.repeat(64) })],
  ...overrides,
});

test('renderReviewBody states the counts, the limit, the report link and each location', () => {
  assert.equal(
    renderReviewBody(summary()),
    [
      'Mutation testing at aaaaaaa: 3 mutants survived on changed lines. 2 are commented inline ' +
        'in this review (limit 5 per commit). The full list is in the ' +
        '[mutation report](https://github.com/owner/repo/actions/runs/55).',
      '',
      'Commented locations:',
      '',
      `- [\`${file}:6\`](https://github.com/owner/repo/blob/${head}/${file}#L6)`,
      `- [\`${file}:6-7\`](https://github.com/owner/repo/blob/${head}/${file}#L6-L7)`,
    ].join('\n'),
  );
});

test('renderReviewBody uses singular wording and marks a partial count as a lower bound', () => {
  const one = renderReviewBody(summary({ survived: 1, post: [makeFinding()] }));
  assert.match(one, /: 1 mutant survived on changed lines\. 1 is commented inline/u);
  const partial = renderReviewBody(summary({ partial: true }));
  assert.match(partial, /: at least 3 mutants survived/u);
});

test('renderReviewBody keeps an untrusted path inside its code span and link', () => {
  const odd = 'packages/data-schemas/src/a `b`](x) <img>\nc.ts';
  const body = renderReviewBody(
    summary({ post: [makeFinding({ file: odd, line: 6, endLine: 6 })] }),
  );
  const lines = body.split('\n');
  assert.equal(lines.length, 5, 'a newline in the path cannot add a line');
  const entry = lines[4];
  assert.ok(entry.startsWith('- [``packages/data-schemas/src/a `b`](x) <img>?c.ts:6``]('));
  assert.ok(
    entry.endsWith(
      `/blob/${head}/packages/data-schemas/src/a%20%60b%60%5D%28x%29%20%3Cimg%3E%0Ac.ts#L6)`,
    ),
  );
});

test('safeLink accepts only https URLs and encodes parentheses', () => {
  assert.equal(safeLink(undefined), undefined);
  assert.equal(safeLink('not a url'), undefined);
  assert.equal(safeLink('http://example.invalid/report'), undefined);
  assert.equal(safeLink('javascript:alert(1)'), undefined);
  assert.equal(
    safeLink('https://example.invalid/r) [x](y'),
    'https://example.invalid/r%29%20[x]%28y',
  );
});

// --- publishInline (thin API layer) -----------------------------------------

const context: Context = {
  repository: 'owner/repo',
  server: 'https://github.com',
  run: 999,
  attempt: 1,
};
const run: WorkflowRun = {
  id: 55,
  event: 'issue_comment',
  path: '.github/workflows/change-quality.yml',
  display_title: 'Quality PR #1 request 10',
  status: 'completed',
  // The run's own head_sha is the default-branch commit for an issue_comment run, not the PR
  // head; publishInline must bind to the request record's head instead.
  head_sha: defaultBranchHead,
  run_attempt: 1,
  repository: { full_name: 'owner/repo' },
};
const request: Request = {
  request: 10,
  pr: 1,
  head,
  base,
  run: 55,
  attempt: 1,
  actor: 'maintainer',
  phase: 'completed',
  conclusion: 'success',
  check: 'mutation',
  scopes: ['data-schemas'],
  staticMutants: false,
};
const requestBody = renderRequest(request, context, head);

class FakeAPI implements API {
  calls: { method: string; path: string; body?: object }[] = [];
  pullHead = head;
  issueComments: { id: number; body: string; user: { login: string; type: string } }[] = [
    { id: 100, body: requestBody, user: { login: 'github-actions[bot]', type: 'Bot' } },
  ];
  files: PullFile[] = [{ filename: file, status: 'modified', patch }];
  reviewThreads: {
    id: number;
    body: string;
    path: string;
    user: { login: string; type: string };
  }[] = [];
  jobs: JobFixture[] = [
    {
      name: 'Mutation report (data-schemas)',
      status: 'completed',
      conclusion: 'success',
      id: 1,
      steps: [{ name: FINDINGS_UPLOAD_STEP, conclusion: 'success' }],
    },
  ];
  posted: object[] = [];
  patched: { id: number; body: string }[] = [];
  fail?: string;
  async request<T>(method: string, path: string, body?: object): Promise<T> {
    this.calls.push({ method, path, body });
    const bare = path.split('?')[0];
    if (this.fail && bare === this.fail) throw new Error('simulated GitHub outage');
    if (method === 'GET' && bare === 'pulls/1') {
      return { head: { sha: this.pullHead }, base: { sha: base } } as T;
    }
    if (method === 'GET' && bare === 'actions/runs/55/jobs') return { jobs: this.jobs } as T;
    if (method === 'GET' && bare === 'issues/1/comments') return this.issueComments as T;
    if (method === 'GET' && bare === 'pulls/1/files') return this.files as T;
    if (method === 'GET' && bare === 'pulls/1/comments') return this.reviewThreads as T;
    if (method === 'PATCH' && bare.startsWith('pulls/comments/')) {
      this.patched.push({
        id: Number(bare.split('/').pop()),
        body: (body as { body: string }).body,
      });
      return undefined as T;
    }
    if (method === 'POST' && bare === 'pulls/1/reviews') {
      this.posted.push(body!);
      return undefined as T;
    }
    throw new Error(`Unexpected request ${method} ${path}`);
  }
}

function findingsDir(doc: QualityFindings | undefined): string {
  const dir = mkdtempSync(join(tmpdir(), 'inline-'));
  if (doc) writeFileSync(join(dir, 'findings.json'), JSON.stringify(doc));
  return dir;
}

test('publishInline posts a single review for a bound survivor', async () => {
  const api = new FakeAPI();
  const dir = findingsDir(makeDoc([makeFinding()]));
  await publishInline(api, context, run, { findingsDir: dir, limit: 5 });
  assert.equal(api.posted.length, 1);
  const review = api.posted[0] as { commit_id: string; event: string; comments: unknown[] };
  assert.equal(review.commit_id, head);
  assert.equal(review.event, 'COMMENT');
  assert.equal(review.comments.length, 1);
  assert.ok(!api.calls.some((call) => call.path.startsWith('statuses')));
  rmSync(dir, { recursive: true, force: true });
});

test('publishInline gives the review a body that counts omitted survivors and links the run', async () => {
  const api = new FakeAPI();
  const dir = findingsDir(makeDoc([makeFinding()], { omitted: 4 }));
  await publishInline(api, context, run, { findingsDir: dir, limit: 5 });
  const review = api.posted[0] as { body: string };
  assert.match(review.body, /^Mutation testing at aaaaaaa: 5 mutants survived on changed lines\./u);
  assert.match(review.body, /1 is commented inline in this review \(limit 5 per commit\)/u);
  assert.match(
    review.body,
    /\[mutation report\]\(https:\/\/github\.com\/owner\/repo\/actions\/runs\/55\)/u,
  );
  assert.match(review.body, new RegExp(`/blob/${head}/${file}#L6-L7\\)$`, 'u'));
  rmSync(dir, { recursive: true, force: true });
});

test('publishInline links the artifact report URL when it has one', async () => {
  const api = new FakeAPI();
  const dir = findingsDir(
    makeDoc([makeFinding()], { reportUrl: 'https://example.invalid/report(1)' }),
  );
  await publishInline(api, context, run, { findingsDir: dir, limit: 5 });
  const review = api.posted[0] as { body: string };
  assert.ok(review.body.includes('[mutation report](https://example.invalid/report%281%29)'));
  rmSync(dir, { recursive: true, force: true });
});

test('publishInline binds to the bot request record head, not the run default-branch head_sha', async () => {
  assert.notEqual(run.head_sha, request.head);
  const api = new FakeAPI();
  const dir = findingsDir(makeDoc([makeFinding()]));
  await publishInline(api, context, run, { findingsDir: dir, limit: 5 });
  assert.equal(api.posted.length, 1);
  const review = api.posted[0] as { commit_id: string };
  assert.equal(review.commit_id, request.head);
  rmSync(dir, { recursive: true, force: true });
});

test('publishInline rejects a request record with a mismatched request id or a later attempt', async () => {
  const wrongId = new FakeAPI();
  wrongId.issueComments = [
    {
      id: 101,
      body: renderRequest({ ...request, request: 999 }, context, head),
      user: { login: 'github-actions[bot]', type: 'Bot' },
    },
  ];
  const dir1 = findingsDir(makeDoc([makeFinding()]));
  await publishInline(wrongId, context, run, { findingsDir: dir1, limit: 5 });
  assert.equal(wrongId.posted.length, 0);
  rmSync(dir1, { recursive: true, force: true });

  const laterAttempt = new FakeAPI();
  laterAttempt.issueComments = [
    {
      id: 102,
      body: renderRequest({ ...request, attempt: run.run_attempt + 1 }, context, head),
      user: { login: 'github-actions[bot]', type: 'Bot' },
    },
  ];
  const dir2 = findingsDir(makeDoc([makeFinding()]));
  await publishInline(laterAttempt, context, run, { findingsDir: dir2, limit: 5 });
  assert.equal(laterAttempt.posted.length, 0);
  rmSync(dir2, { recursive: true, force: true });
});

test('publishInline skips a stale PR head without posting or editing anything', async () => {
  const api = new FakeAPI();
  api.pullHead = otherHead;
  const dir = findingsDir(makeDoc([makeFinding()]));
  await publishInline(api, context, run, { findingsDir: dir, limit: 5 });
  assert.equal(api.posted.length, 0);
  assert.equal(api.patched.length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test('publishInline skips when no request record matches the run', async () => {
  const api = new FakeAPI();
  api.issueComments = [];
  const dir = findingsDir(makeDoc([makeFinding()]));
  await publishInline(api, context, run, { findingsDir: dir, limit: 5 });
  assert.equal(api.posted.length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test('publishInline is a no-op when no findings artifact was downloaded', async () => {
  const api = new FakeAPI();
  const dir = findingsDir(undefined);
  await publishInline(api, context, run, { findingsDir: dir, limit: 5 });
  assert.equal(api.posted.length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test('publishInline is a no-op when the artifact fails validation', async () => {
  const api = new FakeAPI();
  const dir = findingsDir(makeDoc([makeFinding()], { repository: 'someone-else/repo' }));
  await publishInline(api, context, run, { findingsDir: dir, limit: 5 });
  assert.equal(api.posted.length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test('publishInline ignores a findings artifact when the mutation-summary job never ran', async () => {
  const api = new FakeAPI();
  api.jobs = [
    {
      name: 'Mutation testing 1/4 (data-schemas)',
      status: 'completed',
      conclusion: 'success',
      id: 1,
    },
  ];
  const dir = findingsDir(makeDoc([makeFinding()]));
  await publishInline(api, context, run, { findingsDir: dir, limit: 5 });
  assert.equal(api.posted.length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test('publishInline ignores a findings artifact when the mutation-summary job was skipped', async () => {
  const api = new FakeAPI();
  api.jobs = [
    { name: 'Mutation report (data-schemas)', status: 'completed', conclusion: 'skipped', id: 1 },
  ];
  const dir = findingsDir(makeDoc([makeFinding()]));
  await publishInline(api, context, run, { findingsDir: dir, limit: 5 });
  assert.equal(api.posted.length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test('publishInline ignores a findings artifact when the job failed before its own upload ran', async () => {
  const api = new FakeAPI();
  api.jobs = [
    { name: 'Mutation report (data-schemas)', status: 'completed', conclusion: 'failure', id: 1 },
  ];
  const dir = findingsDir(makeDoc([makeFinding()]));
  await publishInline(api, context, run, { findingsDir: dir, limit: 5 });
  assert.equal(api.posted.length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test('publishInline trusts the job from the latest attempt, not a stale earlier-attempt entry', async () => {
  const api = new FakeAPI();
  api.jobs = [
    { name: 'Mutation report (data-schemas)', status: 'completed', conclusion: 'skipped', id: 1 },
    {
      name: 'Mutation report (data-schemas)',
      status: 'completed',
      conclusion: 'success',
      id: 2,
      steps: [{ name: FINDINGS_UPLOAD_STEP, conclusion: 'success' }],
    },
  ];
  const dir = findingsDir(makeDoc([makeFinding()]));
  await publishInline(api, context, run, { findingsDir: dir, limit: 5 });
  assert.equal(api.posted.length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test('publishInline skips a survivor that does not lie on the PR diff', async () => {
  const api = new FakeAPI();
  const dir = findingsDir(makeDoc([makeFinding({ line: 50, endLine: 50 })]));
  await publishInline(api, context, run, { findingsDir: dir, limit: 5 });
  assert.equal(api.posted.length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test('publishInline respects a configured cap across multiple bound survivors', async () => {
  const api = new FakeAPI();
  api.files = [{ filename: file, status: 'modified', patch: '@@ -5,6 +5,6 @@\n a\nb\nc\nd\ne\nf' }];
  const findings = [
    makeFinding({ key: 'a'.repeat(64), line: 6, endLine: 6, rank: 2 }),
    makeFinding({ key: 'b'.repeat(64), line: 7, endLine: 7, rank: 0 }),
    makeFinding({ key: 'c'.repeat(64), line: 8, endLine: 8, rank: 1 }),
  ];
  const dir = findingsDir(makeDoc(findings));
  await publishInline(api, context, run, { findingsDir: dir, limit: 1 });
  assert.equal(api.posted.length, 1);
  const review = api.posted[0] as { comments: { line: number }[] };
  assert.equal(review.comments.length, 1);
  assert.equal(review.comments[0].line, 7);
  rmSync(dir, { recursive: true, force: true });
});

test('publishInline never reposts a surviving key already commented on an earlier run', async () => {
  const api = new FakeAPI();
  const finding = makeFinding();
  api.reviewThreads = [
    {
      id: 500,
      body: renderBody(finding, head),
      path: file,
      user: { login: 'github-actions[bot]', type: 'Bot' },
    },
  ];
  const dir = findingsDir(makeDoc([finding]));
  await publishInline(api, context, run, { findingsDir: dir, limit: 5 });
  assert.equal(api.posted.length, 0);
  assert.equal(api.patched.length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test('publishInline marks a comment stale through the PR API once its survivor is gone', async () => {
  const api = new FakeAPI();
  const posted = makeFinding();
  api.reviewThreads = [
    {
      id: 700,
      body: renderBody(posted, head),
      path: file,
      user: { login: 'github-actions[bot]', type: 'Bot' },
    },
  ];
  const dir = findingsDir(makeDoc([], { detected: [posted.key] }));
  await publishInline(api, context, run, { findingsDir: dir, limit: 5 });
  assert.equal(api.patched.length, 1);
  assert.equal(api.patched[0].id, 700);
  assert.match(api.patched[0].body, /No longer reported at/u);
  rmSync(dir, { recursive: true, force: true });
});

test('publishInline never marks a comment stale when its key is missing from findings but not proven detected', async () => {
  const api = new FakeAPI();
  const posted = makeFinding();
  api.reviewThreads = [
    {
      id: 705,
      body: renderBody(posted, head),
      path: file,
      user: { login: 'github-actions[bot]', type: 'Bot' },
    },
  ];
  // The key is absent from both findings and detected: it could have become Ignored,
  // NoCoverage, or invalid rather than actually killed, so this run cannot prove it is gone.
  const dir = findingsDir(makeDoc([]));
  await publishInline(api, context, run, { findingsDir: dir, limit: 5 });
  assert.equal(api.patched.length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test('publishInline never marks a comment stale when its file carries no patch', async () => {
  const api = new FakeAPI();
  const posted = makeFinding();
  api.files = [{ filename: file, status: 'modified' }];
  api.reviewThreads = [
    {
      id: 701,
      body: renderBody(posted, head),
      path: file,
      user: { login: 'github-actions[bot]', type: 'Bot' },
    },
  ];
  const dir = findingsDir(makeDoc([], { detected: [posted.key] }));
  await publishInline(api, context, run, { findingsDir: dir, limit: 5 });
  assert.equal(api.patched.length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test('publishInline never marks a comment stale when the findings artifact is partial', async () => {
  const api = new FakeAPI();
  const posted = makeFinding();
  api.reviewThreads = [
    {
      id: 702,
      body: renderBody(posted, head),
      path: file,
      user: { login: 'github-actions[bot]', type: 'Bot' },
    },
  ];
  const dir = findingsDir(makeDoc([], { status: 'partial', detected: [posted.key] }));
  await publishInline(api, context, run, { findingsDir: dir, limit: 5 });
  assert.equal(api.patched.length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test('publishInline never marks a comment stale when the findings artifact omitted findings', async () => {
  const api = new FakeAPI();
  const posted = makeFinding();
  api.reviewThreads = [
    {
      id: 704,
      body: renderBody(posted, head),
      path: file,
      user: { login: 'github-actions[bot]', type: 'Bot' },
    },
  ];
  // A run that dropped findings to fit the byte budget cannot prove this survivor is gone, even
  // though its own status still reads 'complete'.
  const dir = findingsDir(makeDoc([], { omitted: 1, detected: [posted.key] }));
  await publishInline(api, context, run, { findingsDir: dir, limit: 5 });
  assert.equal(api.patched.length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test('publishInline is a no-op when the findings status is unavailable, posting or patching nothing', async () => {
  const api = new FakeAPI();
  const posted = makeFinding();
  api.reviewThreads = [
    {
      id: 703,
      body: renderBody(posted, head),
      path: file,
      user: { login: 'github-actions[bot]', type: 'Bot' },
    },
  ];
  const dir = findingsDir(
    makeDoc([], { status: 'unavailable', planDigest: '', detected: [posted.key] }),
  );
  await publishInline(api, context, run, { findingsDir: dir, limit: 5 });
  assert.equal(api.posted.length, 0);
  assert.equal(api.patched.length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test('publishInline disables entirely when the limit is 0, making no API calls', async () => {
  const api = new FakeAPI();
  const dir = findingsDir(makeDoc([makeFinding()]));
  await publishInline(api, context, run, { findingsDir: dir, limit: 0 });
  assert.equal(api.calls.length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test('publishInline skips a run that was not a requested, completed Change Quality run', async () => {
  const api = new FakeAPI();
  const dir = findingsDir(makeDoc([makeFinding()]));
  await publishInline(api, context, { ...run, event: 'push' }, { findingsDir: dir, limit: 5 });
  assert.equal(api.calls.length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test('a publishing failure propagates without ever touching the gate status endpoint', async () => {
  const api = new FakeAPI();
  api.fail = 'pulls/1/reviews';
  const dir = findingsDir(makeDoc([makeFinding()]));
  await assert.rejects(() => publishInline(api, context, run, { findingsDir: dir, limit: 5 }));
  assert.ok(!api.calls.some((call) => call.path.startsWith('statuses')));
  rmSync(dir, { recursive: true, force: true });
});
