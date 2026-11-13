import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

import type { Finding, QualityFindings, Tag } from './findings.mts';
import type { SuppressionAdvisory } from './risk.mts';
import type { ChangedFunction } from './lines.mts';
import type { MutationReport } from './merge.mts';
import type { ShardPlan } from './shards.mts';

import { REASON as LOGGING_ONLY_REASON } from './ignore.mts';
import { findingKey, truncate } from './findings.mts';

type ReportMutant = MutationReport['files'][string]['mutants'][number];
interface Point {
  line: number;
  column: number;
}
interface Span {
  start: Point;
  end: Point;
}
type PlanWithSuppressions = ShardPlan & { suppressions?: SuppressionAdvisory[] };

const TAG_PRIORITY: Tag[] = ['authorization', 'tenant', 'credentials', 'data-loss', 'behavior'];
const KEYWORDS: Partial<Record<Tag, RegExp>> = {
  authorization: /\b(auth\w*|permission\w*|role\w*|acl|access|isadmin|owner\w*|author\w*)\b/iu,
  tenant: /\btenant(id)?\b/iu,
  credentials: /\b(token|secret|password|credential\w*|api[-_]?key|jti|iat|expires)\b/iu,
  'data-loss': /\b(delete\w*|remove\w*|drop|deletemany|\$unset|replace\w*|overwrite\w*)\b/iu,
};
const PRIORITY_MUTATORS = new Set([
  'ConditionalExpression',
  'EqualityOperator',
  'LogicalOperator',
  'BooleanLiteral',
]);

function compare(a: Point, b: Point): number {
  return a.line - b.line || a.column - b.column;
}

/** All targeted functions for the workspace, recovered from any one shard's full plan (every
 * shard carries every other shard's targets, by the strict-check invariant merge.mts enforces). */
export function functionsFromPlan(plan: ShardPlan): Map<string, ChangedFunction[]> {
  const byFile = new Map<string, ChangedFunction[]>();
  for (const shard of plan.shards) {
    for (const target of shard.targets) {
      if (!byFile.has(target.file)) byFile.set(target.file, target.functions);
    }
  }
  return byFile;
}

/** The innermost selected function containing a mutant, mirroring the live progress reporter's
 * own containment test. `undefined` for a module-scope mutant outside any selected function. */
export function ownerFunction(
  functions: ChangedFunction[],
  mutant: { location: Span },
): ChangedFunction | undefined {
  return functions
    .filter(
      (fn) =>
        compare(fn.location.start, mutant.location.start) <= 0 &&
        compare(mutant.location.end, fn.location.end) <= 0,
    )
    .sort(
      (a, b) =>
        compare(b.location.start, a.location.start) || compare(a.location.end, b.location.end),
    )[0];
}

function sliceSpan(source: string, span: Span): string {
  const lines = source.split('\n');
  if (span.start.line === span.end.line) {
    return (lines[span.start.line - 1] ?? '').slice(span.start.column - 1, span.end.column - 1);
  }
  const first = (lines[span.start.line - 1] ?? '').slice(span.start.column - 1);
  const middle = lines.slice(span.start.line, span.end.line - 1);
  const last = (lines[span.end.line - 1] ?? '').slice(0, span.end.column - 1);
  return [first, ...middle, last].join('\n');
}

/** Narrow keyword tags from the mutated code, its enclosing function name, and the file path;
 * never from whether the enclosing function is new or edited. */
export function tagsFor(input: {
  original: string;
  replacement: string;
  functionName: string;
  file: string;
}): Tag[] {
  const haystack = `${input.original}\n${input.replacement}\n${input.functionName}\n${input.file}`;
  const matched = TAG_PRIORITY.filter((tag) => KEYWORDS[tag]?.test(haystack));
  if (input.replacement.trim() === '{}' && !matched.includes('data-loss'))
    matched.push('data-loss');
  if (!matched.length) return ['behavior'];
  return [...new Set(matched)].sort((a, b) => TAG_PRIORITY.indexOf(a) - TAG_PRIORITY.indexOf(b));
}

/** `ObjectLiteral` emptying a filter-shaped literal outranks the other priority mutators, which
 * outrank everything else (including `StringLiteral`), independent of tag or location. */
function mutatorWeight(mutatorName: string, replacement: string): number {
  if (mutatorName === 'ObjectLiteral' && replacement.trim() === '{}') return 0;
  if (PRIORITY_MUTATORS.has(mutatorName)) return 1;
  return 2;
}

/** Lower ranks first. Tag priority dominates; mutator weight breaks ties within a tag; callers
 * break remaining ties by file and line, so neither factor is encoded here. */
export function rankOf(tags: Tag[], mutatorName: string, replacement: string): number {
  const tagIndex = Math.min(...tags.map((tag) => TAG_PRIORITY.indexOf(tag)));
  return tagIndex * 10 + mutatorWeight(mutatorName, replacement);
}

function reasonFor(tags: Tag[], mutatorName: string, functionName: string): string {
  const tagText = tags.length === 1 && tags[0] === 'behavior' ? '' : ` (${tags.join(', ')})`;
  return `A ${mutatorName} mutation in \`${functionName}\` was not detected by any test${tagText}.`;
}

export interface FindingsMeta {
  repository: string;
  pr: number;
  base: string;
  head: string;
  workspace: 'packages/data-schemas';
  planDigest: string;
  status: 'complete' | 'partial';
  reportUrl?: string;
}

interface PositionedMutant {
  file: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  mutator: string;
  original: string;
  replacement: string;
  functionName: string;
  tupleKey: string;
  status: ReportMutant['status'];
}

/** Survivors only; every other status stays in the full report, never in the findings artifact.
 * The ordinal that distinguishes otherwise-identical mutants (same file, mutator, original,
 * replacement, enclosing function) is computed across every mutant with that tuple, not just the
 * survivors: a kill earlier in file/line/column order must still take its slot in the sequence,
 * or killing it would shift a later survivor onto an already-reported key. This also depends on
 * `report` carrying an entry for every planned mutant, finished or not: a partial run's
 * reconstructed report represents each unfinished mutant with a `Pending` stub (same location,
 * mutator, and replacement a finished result would have; neither survived nor detected) so its
 * ordinal slot is still taken, exactly as a `Killed` one would. `detected` collects the key of
 * every mutant whose status is `Killed` or `Timeout`, computed with the same key formula and
 * ordinal, for the privileged consumer to tell "proven killed" apart from merely "not reported as
 * a survivor" (which also covers `Ignored`, `NoCoverage`, an invalid result, or `Pending`). */
export function buildFindings(
  report: MutationReport,
  plan: ShardPlan,
  meta: FindingsMeta,
): QualityFindings {
  const functionsByFile = functionsFromPlan(plan);
  const all: PositionedMutant[] = [];
  for (const [file, value] of Object.entries(report.files)) {
    const functions = functionsByFile.get(file) ?? [];
    for (const mutant of value.mutants) {
      const owner = ownerFunction(functions, mutant);
      const functionName = owner?.function ?? '<module>';
      const original = sliceSpan(value.source, mutant.location);
      const replacement = mutant.replacement ?? '';
      all.push({
        file,
        line: mutant.location.start.line,
        column: mutant.location.start.column,
        endLine: mutant.location.end.line,
        endColumn: mutant.location.end.column,
        mutator: mutant.mutatorName,
        original,
        replacement,
        functionName,
        tupleKey: JSON.stringify([file, mutant.mutatorName, original, replacement, functionName]),
        status: mutant.status,
      });
    }
  }
  // Stable position order, independent of status: the ordinal sequence must not move when a
  // mutant's status changes between runs.
  all.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column);
  const ordinals = new Map<string, number>();
  const findings: Finding[] = [];
  const detected: string[] = [];
  for (const item of all) {
    const ordinal = ordinals.get(item.tupleKey) ?? 0;
    ordinals.set(item.tupleKey, ordinal + 1);
    if (item.status !== 'Survived' && item.status !== 'Killed' && item.status !== 'Timeout')
      continue;
    const key = findingKey({
      file: item.file,
      mutator: item.mutator,
      original: item.original,
      replacement: item.replacement,
      functionName: item.functionName,
      ordinal,
    });
    if (item.status !== 'Survived') {
      detected.push(key);
      continue;
    }
    const tags = tagsFor({
      original: item.original,
      replacement: item.replacement,
      functionName: item.functionName,
      file: item.file,
    });
    const rank = rankOf(tags, item.mutator, item.replacement);
    findings.push({
      file: item.file,
      line: item.line,
      column: item.column,
      endLine: item.endLine,
      endColumn: item.endColumn,
      mutator: item.mutator,
      original: item.original,
      replacement: item.replacement,
      status: 'Survived',
      rank,
      tags,
      reason: reasonFor(tags, item.mutator, item.functionName),
      key,
    });
  }
  findings.sort((a, b) => a.rank - b.rank || a.file.localeCompare(b.file) || a.line - b.line);
  // writeFindings recomputes the real counts if it has to drop any to fit the byte budget.
  return { schema: 'quality-findings/v1', ...meta, findings, detected, omitted: 0 };
}

export function statusCounts(report: MutationReport): Map<string, number> {
  const counts = new Map<string, number>();
  for (const file of Object.values(report.files)) {
    for (const mutant of file.mutants) {
      const status = mutant.status ?? 'Unknown';
      counts.set(status, (counts.get(status) ?? 0) + 1);
    }
  }
  return counts;
}

/** Buckets `Ignored` mutants by why they were ignored: static, logging-only, or the exact
 * `Stryker disable` reason text. */
export function ignoredBreakdown(report: MutationReport): Map<string, number> {
  const buckets = new Map<string, number>();
  for (const file of Object.values(report.files)) {
    for (const mutant of file.mutants) {
      if (mutant.status !== 'Ignored') continue;
      const reason = mutant.statusReason ?? '';
      const bucket =
        reason === LOGGING_ONLY_REASON
          ? 'logging-only'
          : reason.startsWith('Static mutant')
            ? 'static'
            : reason || 'unspecified';
      buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
    }
  }
  return buckets;
}

export interface InvalidMutant {
  file: string;
  line: number;
  column: number;
  mutator: string;
  original: string;
  replacement: string;
  status: 'CompileError' | 'RuntimeError';
  reason: string;
}

/** `CompileError`/`RuntimeError` mutants: Stryker could not run the mutated program to a result
 * at all (a crash while a test file loads is the common case for `RuntimeError`), so these are
 * excluded from the score and listed separately with the reason Stryker gave (`statusReason`),
 * rather than appearing among `NoCoverage` or `Survived`. Sorted by file, then position, like
 * `buildFindings`'s own position order. */
export function invalidMutants(report: MutationReport): InvalidMutant[] {
  const all: InvalidMutant[] = [];
  for (const [file, value] of Object.entries(report.files)) {
    for (const mutant of value.mutants) {
      if (mutant.status !== 'CompileError' && mutant.status !== 'RuntimeError') continue;
      all.push({
        file,
        line: mutant.location.start.line,
        column: mutant.location.start.column,
        mutator: mutant.mutatorName,
        original: sliceSpan(value.source, mutant.location),
        replacement: mutant.replacement ?? '',
        status: mutant.status,
        reason: mutant.statusReason ?? '',
      });
    }
  }
  return all.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column);
}

export interface LineRange {
  start: number;
  end: number;
}

/** `NoCoverage` mutants on changed lines, grouped by file into contiguous line ranges. */
export function noCoverageRanges(report: MutationReport): Map<string, LineRange[]> {
  const byFile = new Map<string, LineRange[]>();
  for (const [file, value] of Object.entries(report.files)) {
    const lines = [
      ...new Set(
        value.mutants
          .filter((mutant) => mutant.status === 'NoCoverage')
          .flatMap((mutant) =>
            Array.from(
              { length: mutant.location.end.line - mutant.location.start.line + 1 },
              (_, index) => mutant.location.start.line + index,
            ),
          ),
      ),
    ].sort((a, b) => a - b);
    if (!lines.length) continue;
    const ranges: LineRange[] = [];
    for (const line of lines) {
      const last = ranges.at(-1);
      if (last && line <= last.end + 1) last.end = line;
      else ranges.push({ start: line, end: line });
    }
    byFile.set(file, ranges);
  }
  return byFile;
}

export interface Scores {
  killedByAssertion?: number;
  strykerScore?: number;
}

/** "Killed by assertion" never counts a `Timeout` as detected; the labeled Stryker score does. */
export function scores(counts: Map<string, number>): Scores {
  const killed = counts.get('Killed') ?? 0;
  const timeout = counts.get('Timeout') ?? 0;
  const survived = counts.get('Survived') ?? 0;
  const noCoverage = counts.get('NoCoverage') ?? 0;
  const assertionTotal = killed + survived + noCoverage;
  const strykerTotal = killed + timeout + survived + noCoverage;
  return {
    killedByAssertion: assertionTotal ? (100 * killed) / assertionTotal : undefined,
    strykerScore: strykerTotal ? (100 * (killed + timeout)) / strykerTotal : undefined,
  };
}

export interface UnfinishedMutant {
  file: string;
  location: Span;
  mutatorName: string;
}

export interface RenderInput {
  workspace: string;
  report: MutationReport;
  findings: QualityFindings;
  suppressions: SuppressionAdvisory[];
  totalExpected?: number;
  unfinished?: UnfinishedMutant[];
}

function escapeCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ⏎ ');
}

const MAX_CODE_CELL = 300;

/** Fences `value` for a table cell with a backtick run longer than any run already in it, per
 * CommonMark, padding with a space on each side only when the content starts or ends with a
 * backtick. */
export function codeCell(value: string): string {
  const content = truncate(escapeCell(value), MAX_CODE_CELL);
  const longestRun = Math.max(0, ...(content.match(/`+/gu) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longestRun + 1);
  const padded = content.startsWith('`') || content.endsWith('`') ? ` ${content} ` : content;
  return `${fence}${padded}${fence}`;
}

/** Leads with changed-line test gaps; the combined JSON and HTML reports stay the source of
 * truth for every mutation location. Survivors are reported as "not detected by tests", never
 * as bugs. */
export function renderMarkdown(input: RenderInput): string {
  const counts = statusCounts(input.report);
  const ignored = ignoredBreakdown(input.report);
  const noCoverage = noCoverageRanges(input.report);
  const { killedByAssertion, strykerScore } = scores(counts);
  const lines: string[] = [`## ${input.workspace}: mutation testing`, ''];
  if (input.findings.status === 'partial' && input.unfinished?.length) {
    const total = input.totalExpected ?? input.unfinished.length;
    lines.push(
      `**Execution budget reached: ${input.unfinished.length} of ${total} mutants unfinished.**`,
      '',
      'Unfinished mutants (not run; not Survived, not NoCoverage):',
      '',
      ...input.unfinished.map(
        (item) =>
          `- ${item.file}:${item.location.start.line}:${item.location.start.column} (${item.mutatorName})`,
      ),
      '',
    );
  }
  lines.push(
    '### Test gaps on changed lines',
    '',
    'Survivors: a test suite that passed unchanged when this mutation ran. They are not detected ' +
      'by tests, not confirmed bugs.',
    '',
    '| Location | Mutator | Original → mutated | Tags |',
    '| --- | --- | --- | --- |',
  );
  if (input.findings.findings.length) {
    for (const finding of input.findings.findings) {
      lines.push(
        `| ${finding.file}:${finding.line}:${finding.column} | ${finding.mutator} | ${codeCell(finding.original)} → ${codeCell(finding.replacement)} | ${finding.tags.join(', ')} |`,
      );
    }
  } else {
    lines.push('| No survivors. | | | |');
  }
  lines.push('', '### No coverage', '', 'Changed code no test executed:', '');
  if (noCoverage.size) {
    for (const [file, ranges] of noCoverage) {
      lines.push(
        `- ${file}: ${ranges.map((r) => (r.start === r.end ? `${r.start}` : `${r.start}-${r.end}`)).join(', ')}`,
      );
    }
  } else {
    lines.push('None.');
  }
  const invalid = invalidMutants(input.report);
  lines.push(
    '',
    '### Invalid mutants',
    '',
    'Mutants Stryker could not run to a result (excluded from the scores, not Survived or ' +
      'NoCoverage):',
    '',
    '| Location | Mutator | Original → mutated | Reason |',
    '| --- | --- | --- | --- |',
  );
  if (invalid.length) {
    for (const item of invalid) {
      lines.push(
        `| ${item.file}:${item.line}:${item.column} | ${item.mutator} | ${codeCell(item.original)} → ${codeCell(item.replacement)} | ${codeCell(item.reason || item.status)} |`,
      );
    }
  } else {
    lines.push('| None. | | | |');
  }
  lines.push('', '### Status', '', '| Result | Mutants |', '| --- | ---: |');
  lines.push(`| Killed | ${counts.get('Killed') ?? 0} |`);
  lines.push(`| Timeout | ${counts.get('Timeout') ?? 0} |`);
  lines.push(`| Survived | ${counts.get('Survived') ?? 0} |`);
  lines.push(`| NoCoverage | ${counts.get('NoCoverage') ?? 0} |`);
  if (ignored.size) {
    for (const [bucket, count] of [...ignored].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`| Ignored (${bucket}) | ${count} |`);
    }
  } else if (counts.get('Ignored')) {
    lines.push(`| Ignored | ${counts.get('Ignored')} |`);
  }
  const invalidCount = (counts.get('CompileError') ?? 0) + (counts.get('RuntimeError') ?? 0);
  if (invalidCount) lines.push(`| Invalid | ${invalidCount} |`);
  // `Pending` stands in for a partial run's unfinished mutants (see buildFindings); it never ran,
  // so it must not inflate how many mutants this run actually tested.
  const ran = [...counts].reduce(
    (total, [status, count]) => (status === 'Pending' ? total : total + count),
    0,
  );
  // A partial run's percentage would read as the real score; label how much ran instead.
  const partialLabel =
    input.findings.status === 'partial'
      ? `partial — ${ran} of ${input.totalExpected ?? ran + (input.unfinished?.length ?? 0)} mutants run`
      : undefined;
  lines.push(
    '',
    '### Scores',
    '',
    `Killed by assertion: Killed/(Killed+Survived+NoCoverage) = ${partialLabel ?? (killedByAssertion === undefined ? 'N/A (no valid mutants)' : `${killedByAssertion.toFixed(2)}%`)}.`,
    `Stryker mutation score (counts timeouts as detected): ${partialLabel ?? (strykerScore === undefined ? 'N/A (no valid mutants)' : `${strykerScore.toFixed(2)}%`)}.`,
  );
  if (input.suppressions.length) {
    lines.push(
      '',
      '### Suppression advisory',
      '',
      'Changed `Stryker disable` comments missing a reason, or naming `all`:',
      '',
      ...input.suppressions.map(
        (item) =>
          `- ${item.file}:${item.line} \`${item.text}\` (${item.problem === 'all' ? 'unscoped all' : 'no reason given'})`,
      ),
    );
  }
  lines.push(
    '',
    '### Source of truth',
    '',
    'This report summarizes the merged Stryker JSON report (`mutation.json`) and its HTML report ' +
      '(`mutation.html`), which hold every mutation location and remain authoritative.',
    '',
  );
  return lines.join('\n');
}

/** Deduplicates the suppression advisory, which every shard's plan carries identically. */
export function dedupeSuppressions(items: SuppressionAdvisory[]): SuppressionAdvisory[] {
  const seen = new Set<string>();
  const result: SuppressionAdvisory[] = [];
  for (const item of items) {
    const key = JSON.stringify(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

/** Renders the merged report with Stryker's own `mutation-testing-elements` viewer, the same way
 * its built-in HTML reporter renders a single shard's report. */
export function renderHtml(report: MutationReport): string {
  const require = createRequire(import.meta.url);
  const scriptContent = readFileSync(
    require.resolve('mutation-testing-elements/dist/mutation-test-elements.js'),
    'utf8',
  );
  const escaped = JSON.stringify(report).replaceAll('<', '<"+"');
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <script>
    ${scriptContent}
  </script>
</head>
<body>
  <mutation-test-report-app titlePostfix="Stryker">
    Your browser doesn't support <a href="https://caniuse.com/#search=custom%20elements">custom elements</a>.
  </mutation-test-report-app>
  <script>
    const app = document.querySelector('mutation-test-report-app');
    app.report = ${escaped};
    function updateTheme() { document.body.style.backgroundColor = app.themeBackgroundColor; }
    app.addEventListener('theme-changed', updateTheme);
    updateTheme();
  </script>
</body>
</html>`;
}

export interface BuildReportInput {
  workspace: string;
  report: MutationReport;
  plan: PlanWithSuppressions;
  meta: FindingsMeta;
  totalExpected?: number;
  unfinished?: UnfinishedMutant[];
}

export function buildReport(input: BuildReportInput): {
  findings: QualityFindings;
  markdown: string;
  html: string;
} {
  const findings = buildFindings(input.report, input.plan, input.meta);
  const markdown = renderMarkdown({
    workspace: input.workspace,
    report: input.report,
    findings,
    suppressions: dedupeSuppressions(input.plan.suppressions ?? []),
    totalExpected: input.totalExpected,
    unfinished: input.unfinished,
  });
  const html = renderHtml(input.report);
  return { findings, markdown, html };
}

export type { ReportMutant };
