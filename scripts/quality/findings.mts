import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

/** The mutation-summary job's output; `inline.mts` validates it independently of this writer. */
export type Tag = 'authorization' | 'tenant' | 'credentials' | 'data-loss' | 'behavior';

export interface Finding {
  key: string;
  file: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  mutator: string;
  original: string;
  replacement: string;
  status: 'Survived';
  rank: number;
  tags: Tag[];
  reason: string;
}

export interface QualityFindings {
  schema: 'quality-findings/v1';
  repository: string;
  pr: number;
  base: string;
  head: string;
  workspace: 'packages/data-schemas';
  planDigest: string;
  status: 'complete' | 'partial' | 'unavailable';
  findings: Finding[];
  /** Keys (the same `findingKey` computation and ordinal sequence as `findings`) of every mutant
   * in this run whose status is `Killed` or `Timeout`. A key missing from both `findings` and
   * `detected` was never positively resolved this run (e.g. `Ignored`, `NoCoverage`, a
   * `CompileError`/`RuntimeError`, or an unfinished mutant on a partial run); only a key present
   * in `detected` is proof that the mutant actually ran and was caught, which is the one condition
   * safe enough to mark a previously reported survivor's comment stale. */
  detected: string[];
  /** How many lowest-priority findings the writer dropped to fit `MAX_ARTIFACT_BYTES`. 0 when
   * nothing was dropped. A consumer must treat `omitted > 0` the same as a partial run for
   * purposes that need the complete finding set, e.g. marking a comment stale. */
  omitted: number;
  reportUrl?: string;
}

export const MAX_TEXT = 2000;
export const MAX_REASON = 500;
const MAX_FINDINGS = 2000;
/** Count bound for `detected`, mirrored in both validators. */
export const MAX_DETECTED = 100_000;
/** The publisher's own upload/download cap (`inline.mts`'s `MAX_ARTIFACT_BYTES`); the single
 * source of truth both the writer and the privileged consumer import, so they can never drift. */
export const MAX_ARTIFACT_BYTES = 1_000_000;
const TRUNCATION_MARKER = '…[truncated]';
const HEX40 = /^[a-f0-9]{40}$/u;
const HEX64 = /^[a-f0-9]{64}$/u;
// Empty matches too: an 'unavailable' artifact carries no plan to digest.
const HEX = /^[a-f0-9]*$/u;
const MUTATOR = /^[A-Za-z]{1,200}$/u;
const TAGS = new Set<Tag>(['authorization', 'tenant', 'credentials', 'data-loss', 'behavior']);

function isHighSurrogate(value: string, index: number): boolean {
  const code = value.charCodeAt(index);
  return code >= 0xd800 && code <= 0xdbff;
}

/** Truncates to at most `max` UTF-16 units, never splitting a surrogate pair. Below the marker's
 * own length, the length bound still holds, just with no room left for the marker. */
export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= TRUNCATION_MARKER.length) {
    let end = Math.max(0, max);
    if (end > 0 && isHighSurrogate(value, end - 1)) end -= 1;
    return value.slice(0, end);
  }
  let end = max - TRUNCATION_MARKER.length;
  if (end > 0 && isHighSurrogate(value, end - 1)) end -= 1;
  return value.slice(0, end) + TRUNCATION_MARKER;
}

/** Position-independent; identical (file, mutator, original, replacement, enclosing function)
 * tuples are distinguished only by the caller-chosen `ordinal`. */
export function findingKey(input: {
  file: string;
  mutator: string;
  original: string;
  replacement: string;
  functionName: string;
  ordinal: number;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        input.file,
        input.mutator,
        input.original,
        input.replacement,
        input.functionName,
        input.ordinal,
      ]),
    )
    .digest('hex');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

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

/** Checks the exact contract this writer promises, mirroring the privileged consumer's own
 * validation in `inline.mts` without importing it. */
export function checkFindings(data: QualityFindings): string | undefined {
  if (data.schema !== 'quality-findings/v1') return 'Unsupported findings schema';
  if (typeof data.repository !== 'string' || !data.repository) return 'Invalid repository';
  // 0 means "no pull request" (a workflow_dispatch run); a real request always has a positive pr.
  if (!isInteger(data.pr, 0, 1_000_000_000)) return 'Invalid pr';
  if (!HEX40.test(data.base)) return 'Invalid base commit';
  if (!HEX40.test(data.head)) return 'Invalid head commit';
  if (data.workspace !== 'packages/data-schemas') return 'Unsupported findings workspace';
  if (!HEX.test(data.planDigest) || data.planDigest.length > 128) return 'Invalid plan digest';
  if (!['complete', 'partial', 'unavailable'].includes(data.status))
    return 'Invalid findings status';
  if (!Array.isArray(data.findings) || data.findings.length > MAX_FINDINGS)
    return 'Invalid findings list';
  if (!data.findings.every(isValidFinding)) return 'Invalid finding entry';
  if (!Array.isArray(data.detected) || data.detected.length > MAX_DETECTED)
    return 'Invalid detected list';
  if (!data.detected.every((key) => typeof key === 'string' && HEX64.test(key)))
    return 'Invalid detected key';
  if (new Set(data.detected).size !== data.detected.length) return 'Duplicate detected key';
  if (!isInteger(data.omitted, 0, 10_000_000)) return 'Invalid omitted count';
  if (
    data.reportUrl !== undefined &&
    (data.reportUrl.length > 500 || !/^https:\/\//u.test(data.reportUrl))
  )
    return 'Invalid report URL';
  const keys = new Set<string>();
  for (const finding of data.findings) {
    if (keys.has(finding.key)) return `Duplicate finding key: ${finding.key}`;
    keys.add(finding.key);
  }
  return undefined;
}

function artifactByteLength(data: QualityFindings): number {
  return Buffer.byteLength(JSON.stringify(data, null, 2), 'utf8');
}

/** Binary search over `kept` findings starting from `cap`: byte size is monotonic in how many are
 * kept, so this needs only O(log n) serializations of `build`, never one per dropped item. */
function largestFitting(cap: number, build: (kept: number) => QualityFindings): number {
  if (artifactByteLength(build(cap)) <= MAX_ARTIFACT_BYTES) return cap;
  let low = 0;
  let high = cap;
  while (low < high) {
    const mid = low + Math.ceil((high - low) / 2);
    if (artifactByteLength(build(mid)) <= MAX_ARTIFACT_BYTES) low = mid;
    else high = mid - 1;
  }
  return low;
}

/** Drops the lowest-priority findings (the tail of the array, which `buildFindings` already
 * sorts most-important first by `rank`) until the kept count is within `MAX_FINDINGS` and the
 * serialized artifact fits `MAX_ARTIFACT_BYTES`, recording how many were dropped in `omitted` —
 * by either limit, so a run with more than `MAX_FINDINGS` short findings reports the overflow
 * instead of leaving a list `checkFindings` would then reject.
 *
 * `findings` take priority: the fit above runs first with `detected` empty, so `detected` can
 * never cause a finding to be dropped. Only once `findings` is settled does a second fit grow
 * `detected` into whatever byte budget is left. Truncating `detected` only ever removes a mutant
 * from "proven detected this run", which only ever suppresses a stale mark — it can never cause an
 * incorrect one — so unlike `omitted` there is no need for a matching counter: a short `detected`
 * list is self-describing and safe by construction. */
function fitWithinArtifactBytes(data: QualityFindings): QualityFindings {
  const total = data.findings.length;
  const withFindings = (kept: number): QualityFindings => ({
    ...data,
    findings: data.findings.slice(0, kept),
    detected: [],
    omitted: total - kept,
  });
  const keptFindings = largestFitting(Math.min(total, MAX_FINDINGS), withFindings);
  const settled = withFindings(keptFindings);
  const withDetected = (kept: number): QualityFindings => ({
    ...settled,
    detected: data.detected.slice(0, kept),
  });
  const keptDetected = largestFitting(Math.min(data.detected.length, MAX_DETECTED), withDetected);
  return withDetected(keptDetected);
}

/** Applies the text caps, drops lowest-priority findings if the result would still exceed the
 * publisher's `MAX_ARTIFACT_BYTES`, validates against this module's own contract, and writes it.
 * Throws rather than publish an artifact that would fail the privileged consumer's checks. */
export function writeFindings(path: string, data: QualityFindings): QualityFindings {
  const capped: QualityFindings = {
    ...data,
    findings: data.findings.map((finding) => ({
      ...finding,
      original: truncate(finding.original, MAX_TEXT),
      replacement: truncate(finding.replacement, MAX_TEXT),
      reason: truncate(finding.reason, MAX_REASON),
    })),
  };
  const fitted = fitWithinArtifactBytes(capped);
  const problem = checkFindings(fitted);
  if (problem) throw new Error(`Refusing to write invalid findings artifact: ${problem}`);
  writeFileSync(path, JSON.stringify(fitted, null, 2));
  return fitted;
}

/** Last-resort safety net for the upload step: writes a placeholder `findings.json` when a
 * skipped or failed merge left none. Best effort: an unresolved base leaves the file absent. */
export function ensureFindingsFile(
  path: string,
  meta: { repository: string; pr: number; base: string; head: string },
): QualityFindings | undefined {
  if (existsSync(path)) return undefined;
  try {
    mkdirSync(dirname(path), { recursive: true });
    return writeFindings(path, {
      schema: 'quality-findings/v1',
      repository: meta.repository,
      pr: meta.pr,
      base: meta.base,
      head: meta.head,
      workspace: 'packages/data-schemas',
      planDigest: '',
      status: 'unavailable',
      findings: [],
      detected: [],
      omitted: 0,
    });
  } catch {
    return undefined;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: {
      output: { type: 'string' },
      repository: { type: 'string' },
      pr: { type: 'string' },
      base: { type: 'string' },
      head: { type: 'string' },
    },
  });
  if (!values.output || !values.repository || !values.pr || !values.head)
    throw new Error('Expected --output, --repository, --pr and --head');
  const pr = Number(values.pr);
  // 0 means "no pull request" (a manual workflow_dispatch run with nothing to comment on).
  if (!Number.isInteger(pr) || pr < 0) throw new Error('--pr must be a non-negative integer');
  const wrote = ensureFindingsFile(values.output, {
    repository: values.repository,
    pr,
    base: values.base || '',
    head: values.head,
  });
  console.log(
    wrote
      ? `Wrote a placeholder 'unavailable' findings.json at ${values.output}.`
      : `${values.output} already exists or could not be written; left it as-is.`,
  );
}
