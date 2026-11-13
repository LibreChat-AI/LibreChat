import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync, readdirSync, statSync } from 'node:fs';

import type { API, Comment, Context, Request } from './comment.mts';
import type { Finding, QualityFindings, Tag } from './findings.mts';

import { client, pages, readRequest } from './comment.mts';
import { MAX_ARTIFACT_BYTES, MAX_DETECTED } from './findings.mts';

export type { Finding, QualityFindings };

export interface PullFile {
  filename: string;
  status: string;
  patch?: string;
}
export interface ExistingComment {
  id: number;
  body: string;
  path: string;
}
export interface CommentPlan {
  post: Finding[];
  update: Array<{ id: number; body: string }>;
  markStale: Array<{ id: number; body: string }>;
}
export interface WorkflowRun {
  id: number;
  event: string;
  path: string;
  display_title: string;
  status: string;
  head_sha: string;
  run_attempt: number;
  repository: { full_name: string };
}
export interface PublishOptions {
  findingsDir: string;
  limit: number;
}
/** Files a stale comment may be marked against: skipped entirely for a 'partial' run. `detected`
 * is the artifact's own list of keys positively confirmed `Killed` or `Timeout` this run; a key
 * missing from `findings` but absent from `detected` too (e.g. `Ignored`, `NoCoverage`, invalid,
 * or simply never run) must never be marked stale. */
export interface StaleScope {
  mutatedFiles: Set<string>;
  patchedFiles: Set<string>;
  detected: Set<string>;
}
type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export const DEFAULT_INLINE_LIMIT = 5;
export const MAX_INLINE_LIMIT = 20;
export { MAX_ARTIFACT_BYTES, MAX_DETECTED };
const MAX_TEXT = 2000;
const MAX_REASON = 500;
const MAX_FINDINGS = 2000;
const HEX40 = /^[a-f0-9]{40}$/u;
const HEX64 = /^[a-f0-9]{64}$/u;
// Empty matches too: an 'unavailable' artifact carries no plan to digest.
const HEX = /^[a-f0-9]*$/u;
const MUTATOR = /^[A-Za-z]{1,200}$/u;
const TAGS = new Set<Tag>(['authorization', 'tenant', 'credentials', 'data-loss', 'behavior']);
const TAG_TEXT: Record<Tag, string> = {
  authorization: 'an authorization check',
  tenant: 'tenant isolation',
  credentials: 'credential handling',
  'data-loss': 'data retention',
  behavior: 'observable behavior',
};
const BOT = { login: 'github-actions[bot]', type: 'Bot' };
const MARKER_LINE =
  /^<!-- quality-mutant:v1 key=([a-f0-9]{64}) head=([a-f0-9]{40}) posted=([a-f0-9]{40}) -->$/u;
const STALE_PREFIX = /^No longer reported at [a-f0-9]{7}\.\n\n/u;

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/** Repo-relative POSIX path with no traversal, absolute, or backslash segment. */
function isSafePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 500 &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    !value.split('/').includes('..')
  );
}

function isValidFinding(value: unknown): value is Finding {
  if (!isPlainObject(value)) return false;
  return (
    typeof value.key === 'string' &&
    HEX64.test(value.key) &&
    isSafePath(value.file) &&
    isInteger(value.line, 1, 10_000_000) &&
    isInteger(value.column, 1, 10_000_000) &&
    isInteger(value.endLine, value.line as number, 10_000_000) &&
    isInteger(value.endColumn, 1, 10_000_000) &&
    typeof value.mutator === 'string' &&
    MUTATOR.test(value.mutator) &&
    typeof value.original === 'string' &&
    value.original.length <= MAX_TEXT &&
    typeof value.replacement === 'string' &&
    value.replacement.length <= MAX_TEXT &&
    value.status === 'Survived' &&
    isInteger(value.rank, 0, 1_000_000) &&
    Array.isArray(value.tags) &&
    value.tags.length > 0 &&
    value.tags.every((tag) => TAGS.has(tag as Tag)) &&
    typeof value.reason === 'string' &&
    value.reason.length > 0 &&
    value.reason.length <= MAX_REASON
  );
}

/** Validates the mutation-summary artifact independently of its producer; the privileged
 * publisher trusts nothing about the artifact's shape beyond what this checks. */
export function validateFindings(
  raw: unknown,
  expected: { repository: string; pr: number; base: string; head: string },
): Result<QualityFindings> {
  if (!isPlainObject(raw)) return fail('Findings artifact is not a JSON object');
  if (raw.schema !== 'quality-findings/v1') return fail('Unsupported findings schema');
  if (raw.repository !== expected.repository) return fail('Findings repository does not match');
  if (!isInteger(raw.pr, 1, 1_000_000_000) || raw.pr !== expected.pr)
    return fail('Findings PR does not match the resolved run');
  if (typeof raw.base !== 'string' || !HEX40.test(raw.base) || raw.base !== expected.base)
    return fail('Findings base commit does not match the request record');
  if (typeof raw.head !== 'string' || !HEX40.test(raw.head) || raw.head !== expected.head)
    return fail('Findings head does not match the tested commit');
  if (raw.workspace !== 'packages/data-schemas') return fail('Unsupported findings workspace');
  if (
    typeof raw.planDigest !== 'string' ||
    !HEX.test(raw.planDigest) ||
    raw.planDigest.length > 128
  )
    return fail('Invalid plan digest');
  if (!['complete', 'partial', 'unavailable'].includes(raw.status as string))
    return fail('Invalid findings status');
  if (!Array.isArray(raw.findings) || raw.findings.length > MAX_FINDINGS)
    return fail('Invalid findings list');
  if (!raw.findings.every(isValidFinding)) return fail('Invalid finding entry');
  if (!Array.isArray(raw.detected) || raw.detected.length > MAX_DETECTED)
    return fail('Invalid detected list');
  if (!raw.detected.every((key) => typeof key === 'string' && HEX64.test(key)))
    return fail('Invalid detected key');
  if (new Set(raw.detected).size !== raw.detected.length) return fail('Duplicate detected key');
  if (!isInteger(raw.omitted, 0, 10_000_000)) return fail('Invalid omitted count');
  if (
    raw.reportUrl !== undefined &&
    (typeof raw.reportUrl !== 'string' ||
      raw.reportUrl.length > 500 ||
      !/^https:\/\//u.test(raw.reportUrl))
  )
    return fail('Invalid report URL');
  return { ok: true, value: raw as unknown as QualityFindings };
}

/** `undefined` means no artifact was downloaded for this run, which is expected, not a failure. */
export function loadFindingsFile(dir: string): Result<unknown | undefined> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return { ok: true, value: undefined };
  }
  if (entries.length === 0) return { ok: true, value: undefined };
  if (entries.length !== 1 || entries[0] !== 'findings.json')
    return fail('Findings artifact must contain exactly one findings.json file');
  const path = join(dir, 'findings.json');
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return fail('Cannot stat findings.json');
  }
  if (size > MAX_ARTIFACT_BYTES) return fail('findings.json exceeds the 1 MB size cap');
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return fail('Cannot read findings.json');
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return fail('findings.json is not valid JSON');
  }
}

/** Fails closed to the default on anything but an in-range integer; 0 disables publishing. */
export function resolveLimit(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_INLINE_LIMIT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > MAX_INLINE_LIMIT) {
    console.warn(
      `Invalid QUALITY_INLINE_LIMIT "${raw}"; using the default of ${DEFAULT_INLINE_LIMIT}.`,
    );
    return DEFAULT_INLINE_LIMIT;
  }
  return value;
}

interface Hunk {
  start: number;
  end: number;
  addedLines: number[];
}

/** Parses a unified patch into right-side hunk ranges and their individual added lines. */
function parseHunks(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | undefined;
  let cursor = 0;
  for (const line of patch.split('\n')) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/u.exec(line);
    if (header) {
      const start = Number(header[1]);
      const count = header[2] === undefined ? 1 : Number(header[2]);
      current = { start, end: start + count - 1, addedLines: [] };
      hunks.push(current);
      cursor = start;
      continue;
    }
    if (!current) continue;
    if (line.startsWith('+')) current.addedLines.push(cursor++);
    else if (line.startsWith(' ')) cursor++;
  }
  return hunks;
}

/** Binds a finding to a hunk's RIGHT side; a range crossing a hunk boundary anchors a
 * single-line comment at its first added line inside the range, or is dropped. */
function bindFinding(finding: Finding, hunks: Hunk[]): Finding | undefined {
  if (finding.line === finding.endLine) {
    return hunks.some((hunk) => finding.line >= hunk.start && finding.line <= hunk.end)
      ? finding
      : undefined;
  }
  const sameHunk = hunks.some(
    (hunk) =>
      finding.line >= hunk.start &&
      finding.line <= hunk.end &&
      finding.endLine >= hunk.start &&
      finding.endLine <= hunk.end,
  );
  if (sameHunk) return finding;
  const anchor = hunks
    .flatMap((hunk) => hunk.addedLines)
    .filter((added) => added >= finding.line && added <= finding.endLine)
    .sort((a, b) => a - b)[0];
  return anchor === undefined ? undefined : { ...finding, line: anchor, endLine: anchor };
}

export function bindToDiff(findings: Finding[], files: PullFile[]): Finding[] {
  const hunks = new Map<string, Hunk[]>();
  for (const file of files) if (file.patch) hunks.set(file.filename, parseHunks(file.patch));
  return findings.flatMap((finding) => {
    const fileHunks = hunks.get(finding.file);
    if (!fileHunks) return [];
    const bound = bindFinding(finding, fileHunks);
    return bound ? [bound] : [];
  });
}

/** A fence longer than any backtick run in the content, so the content cannot escape it. */
export function fence(content: string, minimum = 3): string {
  const longest = Math.max(0, ...[...content.matchAll(/`+/gu)].map((match) => match[0].length));
  return '`'.repeat(Math.max(minimum, longest + 1));
}

/** Renders only validated `tags`, never the artifact's free-text `reason`, outside the fences. */
export function renderBody(finding: Finding, head: string, posted = head): string {
  const sha7 = head.slice(0, 7);
  const originalFence = fence(finding.original);
  const replacementFence = fence(finding.replacement);
  const risk = finding.tags.map((tag) => TAG_TEXT[tag]).join(', ');
  return [
    `<!-- quality-mutant:v1 key=${finding.key} head=${head} posted=${posted} -->`,
    '',
    `This mutant survived the tests at ${sha7}: no test failed when`,
    '',
    originalFence,
    finding.original,
    originalFence,
    '',
    'was replaced with',
    '',
    replacementFence,
    finding.replacement,
    replacementFence,
    '',
    `Consider adding an assertion. Affects: ${risk} (mutator: ${finding.mutator}).`,
  ].join('\n');
}

export function parseMarker(
  body: string,
): { key: string; head: string; posted: string } | undefined {
  const match = MARKER_LINE.exec(body.split('\n', 1)[0]);
  return match ? { key: match[1], head: match[2], posted: match[3] } : undefined;
}

export function updateMarkerHead(body: string, head: string): string {
  return body.replace(
    /^(<!-- quality-mutant:v1 key=[a-f0-9]{64} head=)[a-f0-9]{40}( posted=[a-f0-9]{40} -->)/u,
    `$1${head}$2`,
  );
}

/** Idempotent: re-marking stale at the same head leaves the body unchanged. */
export function markStale(body: string, head: string): string {
  const separator = body.indexOf('\n\n');
  if (separator === -1) return body;
  const marker = body.slice(0, separator);
  const content = body.slice(separator + 2).replace(STALE_PREFIX, '');
  return `${marker}\n\nNo longer reported at ${head.slice(0, 7)}.\n\n${content}`;
}

/** Removes a prior stale note, if any; a no-op on a body that never carried one. */
function stripStale(body: string): string {
  const separator = body.indexOf('\n\n');
  if (separator === -1) return body;
  const marker = body.slice(0, separator);
  const content = body.slice(separator + 2);
  const stripped = content.replace(STALE_PREFIX, '');
  return stripped === content ? body : `${marker}\n\n${stripped}`;
}

/** Selects by rank (as the artifact ranked it, never recomputed), then file and line. */
function selectCandidates(findings: Finding[], exclude: Set<string>, limit: number): Finding[] {
  return findings
    .filter((finding) => !exclude.has(finding.key))
    .slice()
    .sort((a, b) => a.rank - b.rank || a.file.localeCompare(b.file) || a.line - b.line)
    .slice(0, limit);
}

/** Pure dedup/staleness plan: a surviving key is never reposted and revives out of any prior
 * stale note; a key that stops surviving is marked stale, once, only within `stale` scope and
 * only when the artifact's own `detected` list proves it was actually killed or timed out this
 * run, never merely absent from `findings`; new posts are drawn from `bound` and capped per
 * tested head. */
export function planComments(
  survivors: Finding[],
  bound: Finding[],
  existing: ExistingComment[],
  limit: number,
  head: string,
  stale: StaleScope | undefined,
): CommentPlan {
  const marked = existing.flatMap((comment) => {
    const marker = parseMarker(comment.body);
    return marker ? [{ comment, marker }] : [];
  });
  const survivingKeys = new Set(survivors.map((finding) => finding.key));
  const update: CommentPlan['update'] = [];
  const markStaleList: CommentPlan['markStale'] = [];
  for (const { comment, marker } of marked) {
    if (survivingKeys.has(marker.key)) {
      const revived = stripStale(comment.body);
      const updated = marker.head !== head ? updateMarkerHead(revived, head) : revived;
      if (updated !== comment.body) update.push({ id: comment.id, body: updated });
    } else if (
      stale &&
      stale.detected.has(marker.key) &&
      stale.mutatedFiles.has(comment.path) &&
      stale.patchedFiles.has(comment.path)
    ) {
      const staled = markStale(comment.body, head);
      if (staled !== comment.body) markStaleList.push({ id: comment.id, body: staled });
    }
  }
  const alreadyPosted = new Set(marked.map(({ marker }) => marker.key));
  const postedAtHead = marked.filter(({ marker }) => marker.posted === head).length;
  const remaining = Math.max(0, limit - postedAtHead);
  const post = remaining > 0 ? selectCandidates(bound, alreadyPosted, remaining) : [];
  return { post, update, markStale: markStaleList };
}

export function reviewComments(post: Finding[], head: string) {
  return post.map((finding) => ({
    path: finding.file,
    body: renderBody(finding, head),
    line: finding.endLine,
    side: 'RIGHT' as const,
    ...(finding.endLine !== finding.line
      ? { start_line: finding.line, start_side: 'RIGHT' as const }
      : {}),
  }));
}

export interface ReviewSummary {
  head: string;
  /** Survivors on changed lines: listed findings plus those the artifact `omitted`. */
  survived: number;
  partial: boolean;
  limit: number;
  /** Absolute `https:` link to the mutation report, or to the Change Quality run that has it. */
  reportUrl: string;
  /** `server/owner/repo`, the prefix for blob links to the tested commit. */
  repositoryUrl: string;
  post: Finding[];
}

const plural = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`;

const encodeParens = (text: string): string =>
  text.replace(/[()]/gu, (char) => (char === '(' ? '%28' : '%29'));

/** A Markdown link destination: `undefined` for anything but a parseable `https:` URL, and
 * parentheses percent-encoded so the URL cannot close the link early. */
export function safeLink(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:') return undefined;
  return encodeParens(url.href);
}

/** Inline code span for a location; control characters cannot break it out of its line. */
function codeSpan(text: string): string {
  const clean = text.replace(/[\u0000-\u001f\u007f]/gu, '?');
  const ticks = fence(clean, 1);
  const pad = clean.startsWith('`') || clean.endsWith('`') ? ' ' : '';
  return `${ticks}${pad}${clean}${pad}${ticks}`;
}

/** The review body: a reader sees the counts and a link to each commented location in the
 * timeline, even when "Files changed" collapses a large diff behind "Load diff". */
export function renderReviewBody(summary: ReviewSummary): string {
  const sha7 = summary.head.slice(0, 7);
  const survived = `${summary.partial ? 'at least ' : ''}${plural(summary.survived, 'mutant', 'mutants')}`;
  const commented = `${summary.post.length} ${summary.post.length === 1 ? 'is' : 'are'}`;
  const locations = summary.post.map((finding) => {
    const range =
      finding.endLine === finding.line ? `${finding.line}` : `${finding.line}-${finding.endLine}`;
    const anchor =
      finding.endLine === finding.line
        ? `L${finding.line}`
        : `L${finding.line}-L${finding.endLine}`;
    const path = finding.file
      .split('/')
      .map((segment) => encodeParens(encodeURIComponent(segment)))
      .join('/');
    const href = `${summary.repositoryUrl}/blob/${summary.head}/${path}#${anchor}`;
    return `- [${codeSpan(`${finding.file}:${range}`)}](${href})`;
  });
  return [
    `Mutation testing at ${sha7}: ${survived} survived on changed lines. ` +
      `${commented} commented inline in this review (limit ${summary.limit} per commit). ` +
      `The full list is in the [mutation report](${summary.reportUrl}).`,
    '',
    'Commented locations:',
    '',
    ...locations,
  ].join('\n');
}

function isRequestedCompletedRun(
  run: WorkflowRun,
  repository: string,
): { pr: number; request: number } | undefined {
  if (
    run.status !== 'completed' ||
    run.event !== 'issue_comment' ||
    run.path !== '.github/workflows/change-quality.yml' ||
    run.repository?.full_name?.toLowerCase() !== repository.toLowerCase()
  )
    return undefined;
  const match = /^Quality PR #(\d+) request (\d+)$/u.exec(run.display_title);
  return match ? { pr: Number(match[1]), request: Number(match[2]) } : undefined;
}

interface Pull {
  head: { sha: string };
  base: { sha: string };
}
interface ReviewComment {
  id: number;
  body: string;
  path: string;
  user?: { login: string; type: string };
}
interface JobStep {
  name: string;
  conclusion: string | null;
}
interface Job {
  name: string;
  conclusion: string | null;
  status: string;
  id: number;
  steps?: JobStep[];
}

/** change-quality.yml's own step name for the mutation-summary job's quality-findings upload;
 * `workflow.test.mts` asserts the workflow step carries this exact name. */
export const FINDINGS_UPLOAD_STEP = 'Upload quality findings';

/** `mutation-summary` can be skipped for the whole run; an artifact uploaded under the same name
 * by a different (unprivileged) job in that run must never be trusted in its place. The job's own
 * conclusion is not enough: a job that failed before reaching its upload step still reads as
 * 'completed'/non-'skipped', so require that step itself to have succeeded. */
export async function mutationReportRan(
  api: API,
  runId: number,
  workspace: string,
): Promise<boolean> {
  const short = workspace.split('/').pop();
  const jobs = await pages<Job>(api, `actions/runs/${runId}/jobs?filter=all`, 'jobs');
  // Failed-job reruns reuse successful jobs from earlier attempts (comment.mts's own pattern).
  const latest = new Map<string, Job>();
  for (const job of jobs) {
    if ((latest.get(job.name)?.id ?? 0) < job.id) latest.set(job.name, job);
  }
  const report = latest.get(`Mutation report (${short})`);
  return (
    report?.steps?.some(
      (step) => step.name === FINDINGS_UPLOAD_STEP && step.conclusion === 'success',
    ) ?? false
  );
}

/** Downloads nothing itself: the workflow fetches the artifact into `options.findingsDir` beforehand,
 * and this never flips the Quality decision status; any failure here is logged by the caller. */
export async function publishInline(
  api: API,
  context: Context,
  run: WorkflowRun,
  options: PublishOptions,
): Promise<void> {
  if (options.limit <= 0) {
    console.log('Inline mutant comments disabled (QUALITY_INLINE_LIMIT=0).');
    return;
  }
  const requested = isRequestedCompletedRun(run, context.repository);
  if (!requested) {
    console.log('Not a completed requested Change Quality run; skipping inline comments.');
    return;
  }
  const { pr } = requested;
  const pull = await api.request<Pull>('GET', `pulls/${pr}`);
  const issueComments = await pages<Comment>(api, `issues/${pr}/comments`);
  // Bound exactly as the gate publisher binds a run to its request record (comment.mts).
  const request = issueComments
    .map((comment) => readRequest(comment))
    .find(
      (record): record is Request =>
        record !== undefined &&
        record.run === run.id &&
        record.pr === pr &&
        record.request === requested.request &&
        record.attempt <= run.run_attempt,
    );
  if (!request) {
    console.log('No matching quality request record; skipping inline comments.');
    return;
  }
  if (pull.head.sha !== request.head) {
    console.log('PR head moved past the tested commit; skipping stale inline comments.');
    return;
  }
  const loaded = loadFindingsFile(options.findingsDir);
  if (!loaded.ok) {
    console.warn(`Findings artifact invalid: ${loaded.error}`);
    return;
  }
  if (loaded.value === undefined) {
    console.log('No mutation findings artifact for this run.');
    return;
  }
  if (!(await mutationReportRan(api, run.id, 'packages/data-schemas'))) {
    console.warn(
      'No completed mutation-summary job for this run; ignoring the quality-findings artifact.',
    );
    return;
  }
  const validated = validateFindings(loaded.value, {
    repository: context.repository,
    pr,
    base: request.base,
    head: request.head,
  });
  if (!validated.ok) {
    console.warn(`Findings artifact failed validation: ${validated.error}`);
    return;
  }
  if (validated.value.status === 'unavailable') {
    console.log('Mutation findings unavailable for this run; skipping inline comments.');
    return;
  }
  const survivors = validated.value.findings.filter((finding) => finding.status === 'Survived');
  const files = await pages<PullFile>(api, `pulls/${pr}/files`);
  const bound = bindToDiff(survivors, files);
  const threads = await pages<ReviewComment>(api, `pulls/${pr}/comments`);
  const existing = threads
    .filter((comment) => comment.user?.type === BOT.type && comment.user?.login === BOT.login)
    .map((comment) => ({ id: comment.id, body: comment.body, path: comment.path }));
  // Narrowest file set known to have been mutated: every survivor's file (bound or not),
  // plus every PR file in the tested workspace (killed-only files report no survivor).
  const mutatedFiles = new Set([
    ...survivors.map((finding) => finding.file),
    ...files
      .filter((file) => file.filename.startsWith(`${validated.value.workspace}/`))
      .map((file) => file.filename),
  ]);
  const patchedFiles = new Set(files.filter((file) => file.patch).map((file) => file.filename));
  // A partial run and a run that omitted findings to fit the artifact's byte budget both leave
  // the finding set incomplete, so neither can prove a given survivor is actually gone. Even
  // within scope, `detected` (checked per key in planComments) is what actually proves a missing
  // key was killed or timed out, rather than merely not reported as a survivor this run.
  const stale =
    validated.value.status === 'partial' || validated.value.omitted > 0
      ? undefined
      : { mutatedFiles, patchedFiles, detected: new Set(validated.value.detected) };
  const plan = planComments(survivors, bound, existing, options.limit, request.head, stale);
  for (const change of [...plan.update, ...plan.markStale]) {
    await api.request('PATCH', `pulls/comments/${change.id}`, { body: change.body });
  }
  if (plan.post.length) {
    const repositoryUrl = `${context.server}/${context.repository}`;
    await api.request('POST', `pulls/${pr}/reviews`, {
      commit_id: request.head,
      event: 'COMMENT',
      body: renderReviewBody({
        head: request.head,
        survived: survivors.length + validated.value.omitted,
        partial: validated.value.status === 'partial',
        limit: options.limit,
        reportUrl: safeLink(validated.value.reportUrl) ?? `${repositoryUrl}/actions/runs/${run.id}`,
        repositoryUrl,
        post: plan.post,
      }),
      comments: reviewComments(plan.post, request.head),
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const env = process.env;
  try {
    const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH!, 'utf8'));
    if (env.GITHUB_EVENT_NAME !== 'workflow_run' || !event.workflow_run) {
      console.log('Inline mutant comments only publish for workflow_run events.');
    } else {
      const api = client(env);
      const context: Context = {
        repository: env.GITHUB_REPOSITORY!,
        server: env.GITHUB_SERVER_URL!,
        run: Number(env.GITHUB_RUN_ID),
        attempt: Number(env.GITHUB_RUN_ATTEMPT),
      };
      // Re-fetched rather than trusted from the event, matching the gate publisher's own pattern.
      const run = await api.request<WorkflowRun>('GET', `actions/runs/${event.workflow_run.id}`);
      await publishInline(api, context, run, {
        findingsDir: env.QUALITY_FINDINGS_DIR || 'findings',
        limit: resolveLimit(env.QUALITY_INLINE_LIMIT),
      });
    }
  } catch (error) {
    console.error('Inline mutant comment publishing failed; the quality gate is unaffected.');
    console.error(error);
  }
}
