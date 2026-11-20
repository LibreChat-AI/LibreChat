import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

import type { Finding, InvalidFinding, LineRange, MutationSection, Tag } from './findings.mts';
import type { SuppressionAdvisory } from './risk.mts';
import type { ChangedFunction } from './lines.mts';
import type { MutationReport } from './merge.mts';
import type { ShardPlan } from './shards.mts';

import { REASON as LOGGING_ONLY_REASON } from './ignore.mts';
import { findingKey, truncate } from './findings.mts';
import { excerpt } from './coverage.mts';

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
/** Whole-word patterns over identifier words (see `words`), matched as space-separated text. */
const KEYWORDS: Partial<Record<Tag, RegExp>> = {
  authorization:
    /(?:^| )(?:auth|authn|authz|authed|authori[sz](?:e|ed|es|er|ers|ing|ation|ations)|unauthori[sz]ed|authenticat(?:e|ed|es|ing|ion|or|ors)|unauthenticated|permissions?|roles?|acls?|admins?|owners?|ownership)(?= |$)/u,
  tenant: /(?:^| )tenants?(?= |$)/u,
  credentials:
    /(?:^| )(?:tokens?|secrets?|passwords?|credentials?|api keys?|jti|iat|expires)(?= |$)/u,
  'data-loss':
    /(?:^| )(?:delet(?:e|es|ed|ing|ion)|remov(?:e|es|ed|ing|al)|drop(?:s|ped|ping)?|replac(?:e|es|ed|ing|ement)|overwrit(?:e|es|ten|ing)|unset)(?= |$)/u,
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

/** Lines of code a survivor shows before its excerpt is cut; each line is cut at 160 characters. */
export const MAX_SURVIVOR_LINES = 12;

/** The whole source lines a mutant spans, and the same lines with its replacement applied, each
 * capped like a change-risk gap excerpt so one large statement cannot flood the report. */
export function mutantLines(
  source: string,
  span: Span,
  replacement: string,
): { source: string; mutated: string } {
  const lines = source.split('\n').map((line) => line.replace(/\r$/u, ''));
  const prefix = (lines[span.start.line - 1] ?? '').slice(0, span.start.column - 1);
  const suffix = (lines[span.end.line - 1] ?? '').slice(span.end.column - 1);
  const mutated = `${prefix}${replacement}${suffix}`.split(/\r?\n/u);
  const options = { maxLines: MAX_SURVIVOR_LINES };
  return {
    source: excerpt(lines, { start: span.start.line, end: span.end.line }, options),
    mutated: excerpt(mutated, { start: 1, end: mutated.length }, options),
  };
}

/** Splits identifiers into lower-case words: camelCase, PascalCase, acronyms, snake_case,
 * kebab-case, dotted paths, and digits (`refreshToken2` -> `refresh token 2`). */
export function words(value: string): string {
  return value
    .replace(/([a-z\d])([A-Z])/gu, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/gu, '$1 $2')
    .replace(/([A-Za-z])(\d)/gu, '$1 $2')
    .replace(/(\d)([A-Za-z])/gu, '$1 $2')
    .toLowerCase()
    .split(/[^a-z\d]+/u)
    .filter(Boolean)
    .join(' ');
}

export interface Topic {
  tag: Tag;
  /** Matched only through the file path, not the mutated code or its function name. */
  pathOnly: boolean;
}

/** Narrow keyword topics from the mutated code, its enclosing function name, and the file path;
 * never from whether the enclosing function is new or edited. */
export function topicsFor(input: {
  original: string;
  replacement: string;
  functionName: string;
  file: string;
}): Topic[] {
  const code = words(`${input.original} ${input.replacement} ${input.functionName}`);
  const path = words(input.file);
  const topics = TAG_PRIORITY.flatMap((tag): Topic[] => {
    const pattern = KEYWORDS[tag];
    if (!pattern) return [];
    if (pattern.test(code)) return [{ tag, pathOnly: false }];
    return pattern.test(path) ? [{ tag, pathOnly: true }] : [];
  });
  // An emptied object literal widens a filter or drops stored fields.
  if (input.replacement.trim() === '{}') {
    const dataLoss = topics.find(({ tag }) => tag === 'data-loss');
    if (dataLoss) dataLoss.pathOnly = false;
    else topics.push({ tag: 'data-loss', pathOnly: false });
  }
  if (!topics.length) return [{ tag: 'behavior', pathOnly: false }];
  return topics.sort((a, b) => TAG_PRIORITY.indexOf(a.tag) - TAG_PRIORITY.indexOf(b.tag));
}

export function tagsFor(input: Parameters<typeof topicsFor>[0]): Tag[] {
  return topicsFor(input).map(({ tag }) => tag);
}

/** `ObjectLiteral` emptying a filter-shaped literal outranks the other priority mutators, which
 * outrank everything else (including `StringLiteral`), independent of tag or location. */
function mutatorWeight(mutatorName: string, replacement: string): number {
  if (mutatorName === 'ObjectLiteral' && replacement.trim() === '{}') return 0;
  if (PRIORITY_MUTATORS.has(mutatorName)) return 1;
  return 2;
}

/** Lower ranks first. The highest-priority topic sets the leading digit; a topic found only in
 * the file path adds 5, so it follows code-derived matches of the same topic and precedes the
 * next topic. Mutator weight (0 to 2) breaks ties; callers break remaining ties by file and line. */
export function rankOf(topics: Topic[], mutatorName: string, replacement: string): number {
  const lead = Math.min(
    ...topics.map(({ tag, pathOnly }) => TAG_PRIORITY.indexOf(tag) * 10 + (pathOnly ? 5 : 0)),
  );
  return lead + mutatorWeight(mutatorName, replacement);
}

function reasonFor(tags: Tag[], mutatorName: string, functionName: string): string {
  const tagText = tags.length === 1 && tags[0] === 'behavior' ? '' : ` (${tags.join(', ')})`;
  return `A ${mutatorName} mutation in \`${functionName}\` was not detected by any test${tagText}.`;
}

export interface SectionMeta {
  planDigest: string;
  status: 'complete' | 'partial';
}

interface PositionedMutant {
  span: Span;
  source: string;
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

/** Survivors only, most important first; every other status stays in the full report.
 * The ordinal that distinguishes otherwise-identical mutants (same file, mutator, original,
 * replacement, enclosing function) is computed across every mutant with that tuple, not just the
 * survivors: a kill earlier in file/line/column order must still take its slot in the sequence,
 * or killing it would shift a later survivor onto an already-reported key. This also depends on
 * `report` carrying an entry for every planned mutant, finished or not: a partial run's
 * reconstructed report represents each unfinished mutant with a `Pending` stub (same location,
 * mutator, and replacement a finished result would have; neither survived nor detected) so its
 * ordinal slot is still taken, exactly as a `Killed` one would. */
export function buildFindings(report: MutationReport, plan: ShardPlan): Finding[] {
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
        span: mutant.location,
        source: value.source,
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
  for (const item of all) {
    const ordinal = ordinals.get(item.tupleKey) ?? 0;
    ordinals.set(item.tupleKey, ordinal + 1);
    if (item.status !== 'Survived') continue;
    const key = findingKey({
      file: item.file,
      mutator: item.mutator,
      original: item.original,
      replacement: item.replacement,
      functionName: item.functionName,
      ordinal,
    });
    const topics = topicsFor({
      original: item.original,
      replacement: item.replacement,
      functionName: item.functionName,
      file: item.file,
    });
    const tags = topics.map(({ tag }) => tag);
    const rank = rankOf(topics, item.mutator, item.replacement);
    findings.push({
      file: item.file,
      line: item.line,
      column: item.column,
      endLine: item.endLine,
      endColumn: item.endColumn,
      mutator: item.mutator,
      original: item.original,
      replacement: item.replacement,
      ...mutantLines(item.source, item.span, item.replacement),
      status: 'Survived',
      rank,
      tags,
      reason: reasonFor(tags, item.mutator, item.functionName),
      key,
    });
  }
  return findings.sort(
    (a, b) => a.rank - b.rank || a.file.localeCompare(b.file) || a.line - b.line,
  );
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

/** `CompileError`/`RuntimeError` mutants: Stryker could not run the mutated program to a result
 * at all (a crash while a test file loads is the common case for `RuntimeError`), so these are
 * excluded from the score and listed separately with the reason Stryker gave (`statusReason`),
 * rather than appearing among `NoCoverage` or `Survived`. Sorted by file, then position, like
 * `buildFindings`'s own position order. */
export function invalidMutants(report: MutationReport): InvalidFinding[] {
  const all: InvalidFinding[] = [];
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
  status: 'complete' | 'partial';
  findings: Finding[];
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
  if (input.status === 'partial' && input.unfinished?.length) {
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
  if (input.findings.length) {
    for (const finding of input.findings) {
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
    input.status === 'partial'
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

/** The workspace's `quality-findings/v2` mutation section. Scores are `null` for a partial run,
 * whose percentage would read as the real score. `writeFindings` caps the text and list sizes. */
export function buildMutationSection(
  report: MutationReport,
  plan: ShardPlan,
  meta: SectionMeta,
): MutationSection {
  const counts = statusCounts(report);
  const { killedByAssertion, strykerScore } = scores(counts);
  const partial = meta.status === 'partial';
  return {
    workspace: 'data-schemas',
    status: meta.status,
    planDigest: meta.planDigest,
    counts: {
      killed: counts.get('Killed') ?? 0,
      survived: counts.get('Survived') ?? 0,
      timeout: counts.get('Timeout') ?? 0,
      noCoverage: counts.get('NoCoverage') ?? 0,
      invalid: (counts.get('CompileError') ?? 0) + (counts.get('RuntimeError') ?? 0),
      ignored: counts.get('Ignored') ?? 0,
      pending: counts.get('Pending') ?? 0,
    },
    ignored: [...ignoredBreakdown(report)]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([reason, value]) => ({ reason, count: value })),
    scores: {
      killedByAssertion: partial ? null : (killedByAssertion ?? null),
      stryker: partial ? null : (strykerScore ?? null),
    },
    findings: buildFindings(report, plan),
    invalid: invalidMutants(report),
    noCoverage: [...noCoverageRanges(report)].map(([file, ranges]) => ({ file, ranges })),
    omitted: { findings: 0, invalid: 0, noCoverage: 0 },
  };
}

export interface BuildReportInput {
  workspace: string;
  report: MutationReport;
  plan: PlanWithSuppressions;
  meta: SectionMeta;
  totalExpected?: number;
  unfinished?: UnfinishedMutant[];
}

export function buildReport(input: BuildReportInput): {
  section: MutationSection;
  markdown: string;
  html: string;
} {
  const section = buildMutationSection(input.report, input.plan, input.meta);
  const markdown = renderMarkdown({
    workspace: input.workspace,
    report: input.report,
    status: input.meta.status,
    findings: section.findings,
    suppressions: dedupeSuppressions(input.plan.suppressions ?? []),
    totalExpected: input.totalExpected,
    unfinished: input.unfinished,
  });
  const html = renderHtml(input.report);
  return { section, markdown, html };
}

export type { ReportMutant };
