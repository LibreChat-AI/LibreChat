import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';

/** `quality-findings/v2`: the agent contract in the `quality-report` artifact and the only data
 * the privileged comment writer reads. Every reader validates it with `validateFindings`. */
export const SCHEMA = 'quality-findings/v2';

export type Tag = 'authorization' | 'tenant' | 'credentials' | 'data-loss' | 'behavior';
export type Workspace = 'data-schemas' | 'api' | 'server';
export type CoverageState = 'measured' | 'incomplete' | 'unavailable';

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
  /** The whole source lines `line` to `endLine`, at most 12 lines of 160 characters each. */
  source: string;
  /** The same lines with `replacement` applied, capped the same way. */
  mutated: string;
  status: 'Survived';
  rank: number;
  tags: Tag[];
  reason: string;
}

export interface InvalidFinding {
  file: string;
  line: number;
  column: number;
  mutator: string;
  original: string;
  replacement: string;
  status: 'CompileError' | 'RuntimeError';
  reason: string;
}

export interface LineRange {
  start: number;
  end: number;
}

export interface MutationCounts {
  killed: number;
  survived: number;
  timeout: number;
  noCoverage: number;
  invalid: number;
  ignored: number;
  /** Planned mutants a budget-limited (`partial`) run never reached. */
  pending: number;
}

export interface MutationSection {
  workspace: 'data-schemas';
  status: 'complete' | 'partial' | 'unavailable';
  planDigest: string;
  counts: MutationCounts;
  /** `Ignored` mutants by reason: `static`, `logging-only`, or a `Stryker disable` reason. */
  ignored: { reason: string; count: number }[];
  /** Percentages, `null` when the denominator is zero or the run is partial. */
  scores: { killedByAssertion: number | null; stryker: number | null };
  /** Survivors, most important first (`rank`, then file and line). */
  findings: Finding[];
  invalid: InvalidFinding[];
  noCoverage: { file: string; ranges: LineRange[] }[];
  /** Entries dropped from the tail of each list to fit `MAX_ARTIFACT_BYTES`. */
  omitted: { findings: number; invalid: number; noCoverage: number };
}

export interface RiskFile {
  file: string;
  state: CoverageState;
  /** Evidence sources, e.g. "packages/api tests + api/ specs (source alias)". */
  scope: string;
  reasons: string[];
  /** Changed executable lines no test ran; empty for a file that is not `measured`. */
  gaps: (LineRange & { excerpt: string })[];
}

export interface RiskFunction {
  file: string;
  name: string;
  line: number;
  column: number;
  complexity: number;
  cognitiveComplexity: number;
  /** Statement coverage fraction in [0, 1]; `null` when the file has no reliable coverage. */
  coverage: number | null;
  crap: number | null;
  state: CoverageState | null;
}

/** One failing Jest test; `test` is `null` for a suite that failed to run (no test results). */
export interface FailedTest {
  suite: string;
  test: string | null;
}

/** Why a change-risk run produced no report: its own Jest run had failing tests. */
export interface RiskFailure {
  /** Failed tests across every coverage group that ran, counted before `tests` is capped. */
  failedTests: number;
  /** Suites that failed to run, so they report no test results. */
  failedSuites: number;
  /** The first `MAX_FAILED_TESTS` failures, in Jest's result order. */
  tests: FailedTest[];
}

export interface RiskSection {
  workspace: Workspace;
  /** `failed`: the workspace's Jest run had failing tests, described in `failure`. */
  status: 'complete' | 'failed' | 'unavailable';
  coverageScope: string;
  /** Totals over every changed file, counted before any list is shortened. */
  summary: {
    files: number;
    measured: number;
    incomplete: number;
    unavailable: number;
    uncoveredLines: number;
  };
  files: RiskFile[];
  /** Changed functions, highest CRAP first (`null` CRAP last). */
  functions: RiskFunction[];
  omitted: { files: number; functions: number };
  /** Set exactly when `status` is `failed`. */
  failure: RiskFailure | null;
}

export interface QualityFindings {
  schema: typeof SCHEMA;
  repository: string;
  /** 0 for a manual run with no pull request. */
  pr: number;
  base: string;
  head: string;
  risk: RiskSection[];
  mutation: MutationSection[];
}

export const MAX_TEXT = 2000;
export const MAX_REASON = 500;
export const MAX_FAILED_TESTS = 10;
export const MAX_TEST_NAME = 200;
/** Download and upload cap for `findings.json`. */
export const MAX_ARTIFACT_BYTES = 1_000_000;
const MAX_ITEMS = 2000;
const MAX_LIST = 200;
const MAX_LINE = 10_000_000;
const TRUNCATION_MARKER = '…[truncated]';
const HEX40 = /^[a-f0-9]{40}$/u;
const HEX64 = /^[a-f0-9]{64}$/u;
// Empty matches too: an 'unavailable' section carries no plan to digest.
const HEX = /^[a-f0-9]{0,128}$/u;
const MUTATOR = /^[A-Za-z]{1,200}$/u;
const REPOSITORY = /^[A-Za-z\d._-]{1,100}\/[A-Za-z\d._-]{1,100}$/u;
const TAGS = new Set<string>(['authorization', 'tenant', 'credentials', 'data-loss', 'behavior']);
const WORKSPACES = new Set<string>(['data-schemas', 'api', 'server']);
const STATES = new Set<string>(['measured', 'incomplete', 'unavailable']);

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

type Check = (value: unknown) => boolean;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const integer =
  (min: number, max: number): Check =>
  (value) =>
    typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
const number =
  (min: number, max: number): Check =>
  (value) =>
    typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const text =
  (max: number, min = 0): Check =>
  (value) =>
    typeof value === 'string' && value.length >= min && value.length <= max;
const oneOf =
  (values: Set<string>): Check =>
  (value) =>
    typeof value === 'string' && values.has(value);
const nullable =
  (check: Check): Check =>
  (value) =>
    value === null || check(value);
const list =
  (check: Check, max: number): Check =>
  (value) =>
    Array.isArray(value) && value.length <= max && value.every(check);
const count = integer(0, MAX_LINE);
const line = integer(1, MAX_LINE);

/** Repo-relative POSIX path with no traversal, absolute, backslash, or control character. */
export function isSafePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 500 &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    !/[\u0000-\u001f\u007f]/u.test(value) &&
    !value.split('/').includes('..')
  );
}

/** Exactly these keys, each passing its check. */
function shape(fields: Record<string, Check>): Check {
  const names = Object.keys(fields);
  return (value) =>
    isPlainObject(value) &&
    Object.keys(value).length === names.length &&
    names.every((name) => Object.hasOwn(value, name) && fields[name](value[name]));
}

const range = (value: unknown) =>
  shape({ start: line, end: line })(value) &&
  (value as LineRange).end >= (value as LineRange).start;

const isFinding = (value: unknown) =>
  shape({
    key: (key) => typeof key === 'string' && HEX64.test(key),
    file: isSafePath,
    line,
    column: line,
    endLine: line,
    endColumn: line,
    mutator: (mutator) => typeof mutator === 'string' && MUTATOR.test(mutator),
    original: text(MAX_TEXT),
    replacement: text(MAX_TEXT),
    source: text(MAX_TEXT),
    mutated: text(MAX_TEXT),
    status: (status) => status === 'Survived',
    rank: integer(0, 1_000_000),
    tags: (tags) => list(oneOf(TAGS), TAGS.size)(tags) && (tags as unknown[]).length > 0,
    reason: text(MAX_REASON, 1),
  })(value) && (value as Finding).endLine >= (value as Finding).line;

const isInvalid = shape({
  file: isSafePath,
  line,
  column: line,
  mutator: (mutator) => typeof mutator === 'string' && MUTATOR.test(mutator),
  original: text(MAX_TEXT),
  replacement: text(MAX_TEXT),
  status: (status) => status === 'CompileError' || status === 'RuntimeError',
  reason: text(MAX_REASON),
});

const isMutation = shape({
  workspace: (workspace) => workspace === 'data-schemas',
  status: oneOf(new Set(['complete', 'partial', 'unavailable'])),
  planDigest: (digest) => typeof digest === 'string' && HEX.test(digest),
  counts: shape({
    killed: count,
    survived: count,
    timeout: count,
    noCoverage: count,
    invalid: count,
    ignored: count,
    pending: count,
  }),
  ignored: list(shape({ reason: text(MAX_REASON, 1), count }), MAX_LIST),
  scores: shape({
    killedByAssertion: nullable(number(0, 100)),
    stryker: nullable(number(0, 100)),
  }),
  findings: list(isFinding, MAX_ITEMS),
  invalid: list(isInvalid, MAX_ITEMS),
  noCoverage: list(shape({ file: isSafePath, ranges: list(range, MAX_ITEMS) }), MAX_ITEMS),
  omitted: shape({ findings: count, invalid: count, noCoverage: count }),
});

const isRiskFile = shape({
  file: isSafePath,
  state: oneOf(STATES),
  scope: text(MAX_REASON),
  reasons: list(text(MAX_REASON), 20),
  gaps: list(
    (gap) =>
      isPlainObject(gap) &&
      range({ start: gap.start, end: gap.end }) &&
      Object.keys(gap).length === 3 &&
      text(MAX_TEXT)(gap.excerpt),
    MAX_ITEMS,
  ),
});

const isRiskFunction = shape({
  file: isSafePath,
  name: text(200, 1),
  line,
  column: count,
  complexity: count,
  cognitiveComplexity: count,
  coverage: nullable(number(0, 1)),
  crap: nullable(number(0, 1e12)),
  state: nullable(oneOf(STATES)),
});

const isRiskFailure = shape({
  failedTests: count,
  failedSuites: count,
  tests: list(
    shape({ suite: isSafePath, test: nullable(text(MAX_TEST_NAME, 1)) }),
    MAX_FAILED_TESTS,
  ),
});

const isRiskShape = shape({
  workspace: oneOf(WORKSPACES),
  status: oneOf(new Set(['complete', 'failed', 'unavailable'])),
  coverageScope: text(MAX_REASON),
  summary: shape({
    files: count,
    measured: count,
    incomplete: count,
    unavailable: count,
    uncoveredLines: count,
  }),
  files: list(isRiskFile, MAX_ITEMS),
  functions: list(isRiskFunction, MAX_ITEMS),
  omitted: shape({ files: count, functions: count }),
  failure: nullable(isRiskFailure),
});

const isRisk = (value: unknown) =>
  isRiskShape(value) &&
  ((value as RiskSection).status === 'failed') === ((value as RiskSection).failure !== null);

type Result<T> = { ok: true; value: T } | { ok: false; error: string };
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

/** Strict structural validation: exact keys, types, ranges, text caps, safe paths, and one
 * section per workspace. With `expected`, the document must also belong to that exact request. */
export function validateFindings(
  raw: unknown,
  expected?: { repository: string; pr: number; base: string; head: string },
): Result<QualityFindings> {
  if (!isPlainObject(raw)) return fail('Findings are not a JSON object');
  if (raw.schema !== SCHEMA) return fail('Unsupported findings schema');
  const keys = ['schema', 'repository', 'pr', 'base', 'head', 'risk', 'mutation'];
  if (Object.keys(raw).length !== keys.length || !keys.every((key) => Object.hasOwn(raw, key)))
    return fail('Unexpected findings fields');
  if (typeof raw.repository !== 'string' || !REPOSITORY.test(raw.repository))
    return fail('Invalid repository');
  if (!integer(0, 1_000_000_000)(raw.pr)) return fail('Invalid pr');
  if (typeof raw.base !== 'string' || !HEX40.test(raw.base)) return fail('Invalid base commit');
  if (typeof raw.head !== 'string' || !HEX40.test(raw.head)) return fail('Invalid head commit');
  if (!list(isRisk, WORKSPACES.size)(raw.risk)) return fail('Invalid change-risk section');
  if (!list(isMutation, 1)(raw.mutation)) return fail('Invalid mutation section');
  const workspaces = (raw.risk as RiskSection[]).map(({ workspace }) => workspace);
  if (new Set(workspaces).size !== workspaces.length) return fail('Duplicate change-risk section');
  const findingKeys = (raw.mutation as MutationSection[]).flatMap(({ findings }) =>
    findings.map(({ key }) => key),
  );
  if (new Set(findingKeys).size !== findingKeys.length) return fail('Duplicate finding key');
  if (expected) {
    if (raw.repository.toLowerCase() !== expected.repository.toLowerCase())
      return fail('Findings repository does not match');
    if (raw.pr !== expected.pr) return fail('Findings PR does not match the request');
    if (raw.base !== expected.base) return fail('Findings base does not match the request');
    if (raw.head !== expected.head) return fail('Findings head does not match the tested commit');
  }
  return { ok: true, value: raw as unknown as QualityFindings };
}

function byteLength(data: QualityFindings): number {
  return Buffer.byteLength(JSON.stringify(data, null, 2), 'utf8');
}

/** Largest `kept` in [0, cap] whose build fits; size is monotonic in `kept`. */
function largestFitting(cap: number, build: (kept: number) => QualityFindings): number {
  if (byteLength(build(cap)) <= MAX_ARTIFACT_BYTES) return cap;
  let low = 0;
  let high = cap;
  while (low < high) {
    const mid = low + Math.ceil((high - low) / 2);
    if (byteLength(build(mid)) <= MAX_ARTIFACT_BYTES) low = mid;
    else high = mid - 1;
  }
  return low;
}

type Trim = (data: QualityFindings, kept: number) => QualityFindings;
const trimMutation =
  (field: 'findings' | 'invalid' | 'noCoverage'): Trim =>
  (data, kept) => ({
    ...data,
    mutation: data.mutation.map((section) => ({
      ...section,
      [field]: section[field].slice(0, kept),
      omitted: {
        ...section.omitted,
        [field]: section.omitted[field] + Math.max(0, section[field].length - kept),
      },
    })),
  });
const trimRisk =
  (field: 'files' | 'functions'): Trim =>
  (data, kept) => ({
    ...data,
    risk: data.risk.map((section) => ({
      ...section,
      [field]: section[field].slice(0, kept),
      omitted: {
        ...section.omitted,
        [field]: section.omitted[field] + Math.max(0, section[field].length - kept),
      },
    })),
  });
/** Least important first: each list is shortened from its tail (lowest priority) only when the
 * lists before it are already empty and the document still exceeds the byte cap. */
const TRIMS: [Trim, (data: QualityFindings) => number][] = [
  [trimMutation('invalid'), (data) => Math.max(0, ...data.mutation.map((s) => s.invalid.length))],
  [
    trimMutation('noCoverage'),
    (data) => Math.max(0, ...data.mutation.map((s) => s.noCoverage.length)),
  ],
  [trimRisk('functions'), (data) => Math.max(0, ...data.risk.map((s) => s.functions.length))],
  [trimRisk('files'), (data) => Math.max(0, ...data.risk.map((s) => s.files.length))],
  [trimMutation('findings'), (data) => Math.max(0, ...data.mutation.map((s) => s.findings.length))],
];

/** Applies the per-list item caps, then shortens lists until the document fits
 * `MAX_ARTIFACT_BYTES`, recording every dropped entry in its section's `omitted` counts. */
export function fitFindings(data: QualityFindings): QualityFindings {
  let fitted = data;
  for (const [trim, longest] of TRIMS) fitted = trim(fitted, Math.min(longest(fitted), MAX_ITEMS));
  for (const [trim, longest] of TRIMS) {
    if (byteLength(fitted) <= MAX_ARTIFACT_BYTES) break;
    const current = fitted;
    fitted = trim(
      current,
      largestFitting(longest(current), (kept) => trim(current, kept)),
    );
  }
  return fitted;
}

/** Caps text fields, fits the byte budget, validates, and writes. Throws rather than write a
 * document that `validateFindings` would reject. */
export function writeFindings(path: string, data: QualityFindings): QualityFindings {
  const capped: QualityFindings = {
    ...data,
    mutation: data.mutation.map((section) => ({
      ...section,
      findings: section.findings.map((finding) => ({
        ...finding,
        original: truncate(finding.original, MAX_TEXT),
        replacement: truncate(finding.replacement, MAX_TEXT),
        source: truncate(finding.source, MAX_TEXT),
        mutated: truncate(finding.mutated, MAX_TEXT),
        reason: truncate(finding.reason, MAX_REASON),
      })),
      invalid: section.invalid.map((item) => ({
        ...item,
        original: truncate(item.original, MAX_TEXT),
        replacement: truncate(item.replacement, MAX_TEXT),
        reason: truncate(item.reason, MAX_REASON),
      })),
      ignored: section.ignored
        .slice(0, MAX_LIST)
        .map((item) => ({ ...item, reason: truncate(item.reason, MAX_REASON) })),
    })),
  };
  const fitted = fitFindings(capped);
  const checked = validateFindings(fitted);
  if (!checked.ok) throw new Error(`Refusing to write invalid findings: ${checked.error}`);
  writeFileSync(path, JSON.stringify(fitted, null, 2));
  return fitted;
}

/** A section for a workspace whose data is missing or failed validation. */
export function unavailableMutation(): MutationSection {
  return {
    workspace: 'data-schemas',
    status: 'unavailable',
    planDigest: '',
    counts: {
      killed: 0,
      survived: 0,
      timeout: 0,
      noCoverage: 0,
      invalid: 0,
      ignored: 0,
      pending: 0,
    },
    ignored: [],
    scores: { killedByAssertion: null, stryker: null },
    findings: [],
    invalid: [],
    noCoverage: [],
    omitted: { findings: 0, invalid: 0, noCoverage: 0 },
  };
}

export function unavailableRisk(workspace: Workspace): RiskSection {
  return {
    workspace,
    status: 'unavailable',
    coverageScope: '',
    summary: { files: 0, measured: 0, incomplete: 0, unavailable: 0, uncoveredLines: 0 },
    files: [],
    functions: [],
    omitted: { files: 0, functions: 0 },
    failure: null,
  };
}

/** Reads a directory that must hold exactly one `findings.json` within the byte cap.
 * `undefined` means the directory is absent or empty, which is not a failure. */
export function loadFindingsFile(dir: string): Result<unknown> {
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
    const stat = lstatSync(path);
    if (!stat.isFile()) return fail('findings.json is not a regular file');
    size = stat.size;
  } catch {
    return fail('Cannot stat findings.json');
  }
  if (size > MAX_ARTIFACT_BYTES) return fail('findings.json exceeds the 1 MB size cap');
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, 'utf8')) };
  } catch {
    return fail('findings.json is not valid JSON');
  }
}
