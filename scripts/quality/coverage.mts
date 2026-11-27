import { createRequire } from 'node:module';
import { basename, resolve } from 'node:path';

import { git } from './changes.mts';

/** `measured` needs a clean, hash-matched run; `unavailable` means no run even produced the key. */
export type CoverageState = 'measured' | 'incomplete' | 'unavailable';

export interface LineRange {
  start: number;
  end: number;
}

export interface SuiteStatus {
  testFilePath: string;
  failed: boolean;
  runtimeError: boolean;
}

export interface RevisionCheck {
  ok: boolean;
  head: string;
  reason?: string;
}

/** One Jest invocation's evidence for a set of changed files. */
export interface RunEvidence {
  /** Shown in the report, e.g. "packages/api tests" or "api/ specs (source alias)". */
  label: string;
  /** Parsed `coverage-final.json`, keyed by absolute source path. */
  coverage: Record<string, unknown>;
  /** Parsed Jest `--json` results (`AggregatedResult`) for every suite this run executed. */
  suites: SuiteStatus[];
  /** Absolute spec paths this run selected for each changed file (by absolute path). Omit for a
   * run with no per-file breakdown: any failing suite then marks every file it covers incomplete. */
  relatedSpecs?: Record<string, string[]>;
  /** Source checkout binding; omit when the run shares the already-verified checkout. */
  revision?: RevisionCheck;
  /** Set when the run itself failed operationally (timeout, crash, no output) before producing
   * usable coverage. Every file this run was asked to cover becomes `incomplete` with this
   * reason, regardless of whether a coverage key happens to be present. */
  runFailure?: string;
}

export interface FileCoverageResult {
  file: string;
  state: CoverageState;
  reasons: string[];
  sources: string[];
  /** Merged istanbul `FileCoverageData`, present whenever at least one run contributed hash-matched data. */
  entry?: Record<string, unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isEmptyMap = (value: unknown) =>
  value === undefined || (isRecord(value) && !Object.keys(value).length);

/** True for an entry with no statements, functions or branches. */
function isEmptyEntry(data: Record<string, unknown>): boolean {
  return isEmptyMap(data.statementMap) && isEmptyMap(data.fnMap) && isEmptyMap(data.branchMap);
}

/** Verifies a run's source matches the tested head and carries no local edits before it is trusted. */
export function checkRevision(cwd: string, expectedHead: string, files: string[]): RevisionCheck {
  const head = git(['rev-parse', 'HEAD'], cwd).trim();
  if (head !== expectedHead) {
    return {
      ok: false,
      head,
      reason: `checkout HEAD ${head} does not match tested head ${expectedHead}`,
    };
  }
  if (!files.length) return { ok: true, head };
  const dirty = git(['status', '--porcelain', '--', ...files], cwd).trim();
  if (dirty) return { ok: false, head, reason: 'tested files have uncommitted changes' };
  return { ok: true, head };
}

/** Reads Jest's `--json --outputFile` report (the `formatTestResults` reporter shape, which
 * renames each suite's path to `name` and collapses its outcome to `status`) into per-suite
 * pass/fail facts. A suite that fails with no individual assertion results crashed outright
 * (a require-time throw or similar), rather than failing a collected test. */
export function suiteStatuses(resultsJson: unknown): SuiteStatus[] {
  if (!isRecord(resultsJson) || !Array.isArray(resultsJson.testResults)) {
    throw new Error('Invalid Jest results JSON: expected an AggregatedResult with testResults');
  }
  return resultsJson.testResults.map((entry) => {
    if (!isRecord(entry) || typeof entry.name !== 'string' || typeof entry.status !== 'string') {
      throw new Error('Invalid Jest test result entry');
    }
    const failed = entry.status === 'failed';
    const runtimeError =
      failed && Array.isArray(entry.assertionResults) && entry.assertionResults.length === 0;
    return { testFilePath: entry.name, runtimeError, failed };
  });
}

/** A run contributes failure for `key` (the resolved file path used throughout `relatedSpecs` and
 * `coverage`) when a related suite failed; with no breakdown, any failure does. */
function attribution(run: RunEvidence, key: string): { failed: boolean; reason?: string } {
  const related = run.relatedSpecs?.[key];
  const candidates = related
    ? run.suites.filter((suite) => related.includes(suite.testFilePath))
    : run.suites;
  const failing = candidates.filter((suite) => suite.failed);
  if (!failing.length) return { failed: false };
  const names = failing.map((suite) => basename(suite.testFilePath)).join(', ');
  return { failed: true, reason: `${names} failed in ${run.label}` };
}

/** Merges istanbul data for one file across runs. Only hash-matched entries merge; otherwise the
 * file is `incomplete` with no merged entry. A clean run's failing related suite also marks it
 * `incomplete`, independent of the merge itself. Absence everywhere is `unavailable`. */
export function mergeFileCoverage(file: string, runs: RunEvidence[]): FileCoverageResult {
  const key = resolve(file);
  const reasons: string[] = [];
  const sources: string[] = [];
  const usable: { run: RunEvidence; data: Record<string, unknown> }[] = [];
  let incomplete = false;
  for (const run of runs) {
    if (run.runFailure) {
      incomplete = true;
      reasons.push(`${run.label}: ${run.runFailure}`);
      sources.push(`${run.label} (discarded)`);
      continue;
    }
    const data = run.coverage[key];
    if (!isRecord(data)) continue;
    if (run.revision && !run.revision.ok) {
      incomplete = true;
      reasons.push(`${run.label}: ${run.revision.reason ?? 'revision mismatch'}`);
      sources.push(`${run.label} (discarded)`);
      continue;
    }
    usable.push({ run, data });
  }
  if (!usable.length) {
    return {
      file,
      state: reasons.length ? 'incomplete' : 'unavailable',
      reasons: reasons.length
        ? reasons
        : ['no source ran for this file, or the coverage key is missing from every run'],
      sources,
    };
  }
  // A single usable run has nothing to compare against; two or more must each carry a matching
  // string hash, or the data cannot be trusted to describe the same statement map. A file with
  // nothing to instrument (a type-only module) gets istanbul's empty placeholder, which has no
  // hash; such entries describe the same empty map and merge.
  const hashes = usable.map(({ data }) => (typeof data.hash === 'string' ? data.hash : undefined));
  const canMerge =
    usable.length === 1 ||
    (hashes[0] !== undefined && hashes.every((hash) => hash === hashes[0])) ||
    usable.every(({ data }) => isEmptyEntry(data));
  let entry: Record<string, unknown> | undefined;
  if (!canMerge) {
    incomplete = true;
    reasons.push('statement-map hash differs between contributing runs; coverage was not merged');
  } else {
    const { createCoverageMap } = createRequire(resolve('package.json'))(
      'istanbul-lib-coverage',
    ) as typeof import('istanbul-lib-coverage');
    const map = createCoverageMap({});
    for (const { data } of usable) map.merge({ [key]: data } as never);
    entry = map.fileCoverageFor(key).toJSON() as Record<string, unknown>;
  }
  for (const { run } of usable) {
    sources.push(run.label);
    const { failed, reason } = attribution(run, key);
    if (failed) {
      incomplete = true;
      reasons.push(reason!);
    }
  }
  return { file, state: incomplete ? 'incomplete' : 'measured', reasons, sources, entry };
}

interface ChangedLineCoverage {
  covered: number[];
  uncovered: number[];
  /** Changed lines with no statement; not executable for this purpose and excluded from both sets. */
  noStatement: number[];
}

interface Statement {
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
  hits: number;
}

/** Smaller span first: fewest lines, then fewest columns. Picks the innermost of several
 * statements that all contain the same line (for example a call and its multiline arguments). */
function compareSpan(a: Statement, b: Statement): number {
  return (
    a.endLine - a.startLine - (b.endLine - b.startLine) ||
    a.endColumn - a.startColumn - (b.endColumn - b.startColumn)
  );
}

/** A changed line is covered by whichever statements it "belongs to": the statements that START
 * on that line when any do (so a line holding both a working outer statement and a dead nested
 * one, e.g. `if (a) return b;`, counts as covered as soon as one of them ran), otherwise the
 * innermost statement that merely contains the line (so an uncalled arrow body is reported
 * uncovered even though its enclosing declaration ran, and a multiline call's argument lines
 * inherit the call statement's own hit count). */
export function changedLineCoverage(
  lines: number[],
  entry: Record<string, unknown>,
): ChangedLineCoverage {
  if (!isRecord(entry.statementMap) || !isRecord(entry.s)) {
    throw new Error('Invalid coverage entry: expected statementMap and s');
  }
  const statements: Statement[] = [];
  const startingAt = new Map<number, Statement[]>();
  for (const [id, location] of Object.entries(entry.statementMap)) {
    if (!isRecord(location) || !isRecord(location.start) || !isRecord(location.end)) {
      throw new Error(`Invalid statement location: ${id}`);
    }
    const startLine = location.start.line;
    const endLine = location.end.line;
    if (typeof startLine !== 'number' || typeof endLine !== 'number') {
      throw new Error(`Invalid statement line bounds: ${id}`);
    }
    const hits = entry.s[id];
    if (typeof hits !== 'number') throw new Error(`Missing statement counter: ${id}`);
    const startColumn = typeof location.start.column === 'number' ? location.start.column : 0;
    const endColumn = typeof location.end.column === 'number' ? location.end.column : 0;
    const statement: Statement = { startLine, endLine, startColumn, endColumn, hits };
    statements.push(statement);
    const existing = startingAt.get(startLine);
    if (existing) existing.push(statement);
    else startingAt.set(startLine, [statement]);
  }
  const innermostContaining = (line: number): Statement | undefined => {
    let best: Statement | undefined;
    for (const statement of statements) {
      if (statement.startLine > line || statement.endLine < line) continue;
      if (!best || compareSpan(statement, best) < 0) best = statement;
    }
    return best;
  };
  const covered: number[] = [];
  const uncovered: number[] = [];
  const noStatement: number[] = [];
  for (const line of lines) {
    const starting = startingAt.get(line);
    if (starting?.length) {
      if (starting.some((statement) => statement.hits > 0)) covered.push(line);
      else uncovered.push(line);
      continue;
    }
    const containing = innermostContaining(line);
    if (!containing) noStatement.push(line);
    else if (containing.hits > 0) covered.push(line);
    else uncovered.push(line);
  }
  return { covered, uncovered, noStatement };
}

/** Groups sorted or unsorted line numbers into contiguous inclusive ranges. */
export function groupRanges(lines: number[]): LineRange[] {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const ranges: LineRange[] = [];
  for (const line of sorted) {
    const last = ranges.at(-1);
    if (last && line === last.end + 1) last.end = line;
    else ranges.push({ start: line, end: line });
  }
  return ranges;
}

/** The source lines of a gap, for a fenced code block in the report. Each line keeps its own
 * line break and is cut at `maxChars`; a gap longer than `maxLines` keeps its first lines and
 * states how many it omits, so one giant statement cannot flood the comment. */
export function excerpt(
  sourceLines: string[],
  range: LineRange,
  { maxLines = 8, maxChars = 160 }: { maxLines?: number; maxChars?: number } = {},
): string {
  const lines = sourceLines.slice(range.start - 1, range.end);
  const kept = lines
    .slice(0, maxLines)
    .map((line) => (line.length > maxChars ? `${line.slice(0, maxChars)}…` : line));
  const omitted = lines.length - kept.length;
  return [
    ...kept,
    ...(omitted > 0 ? [`… ${omitted} more line${omitted === 1 ? '' : 's'}`] : []),
  ].join('\n');
}
