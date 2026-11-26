import type {
  FailedTest,
  Finding,
  InvalidFinding,
  LineRange,
  QualityFindings,
  RiskFile,
  RiskFunction,
  RiskSection,
  Workspace,
} from './findings.mts';

import { truncate } from './findings.mts';

/** GitHub rejects an issue comment body above this many characters. */
export const COMMENT_LIMIT = 65_536;
export const DEFAULT_REFACTOR_HINTS = 10;
export const MAX_REFACTOR_HINTS = 100;
export const DEFAULT_CRAP_THRESHOLD = 30;
export const MAX_CRAP_THRESHOLD = 10_000;
/** Survivors written out in full on one line's entry before "N more". */
export const SURVIVORS_PER_LINE = 3;
const MAX_SPAN = 120;
const CONTROL = /[\u0000-\u001f\u007f]/gu;

/** A fence longer than any backtick run in the content, so the content cannot escape it. */
export function fence(content: string, minimum = 3): string {
  const longest = Math.max(0, ...[...content.matchAll(/`+/gu)].map((match) => match[0].length));
  return '`'.repeat(Math.max(minimum, longest + 1));
}

/** Inline code span: control characters (newlines included) become `?`, so the span stays on
 * one line. A span inside a table cell also goes through `row`, which escapes `|`. */
export function codeSpan(text: string, max = MAX_SPAN): string {
  const clean = truncate(text, max).replace(CONTROL, '?');
  const ticks = fence(clean, 1);
  const pad = clean.startsWith('`') || clean.endsWith('`') ? ' ' : '';
  return `${ticks}${pad}${clean}${pad}${ticks}`;
}

/** Mutated source for a span: line breaks shown as `⏎` rather than replaced with `?`. */
function sourceSpan(text: string): string {
  return codeSpan(text.replace(/\r\n|\n|\r/gu, ' ⏎ '));
}

/** A table row. GFM splits cells on `|` before it parses code spans, so each `|` in a cell is
 * escaped, and inside a code span `\|` then renders as `|`. Outside a table `\|` renders
 * literally, so only table cells are escaped. */
export function row(cells: (string | number)[]): string {
  return `| ${cells.map((cell) => String(cell).replaceAll('|', '\\|')).join(' | ')} |`;
}

const CHECKOUT = /(?:\/home\/runner\/work|\/__w)\/[^/\s]+\/[^/\s]+\/(?:source\/)?/gu;
const SANDBOX = /\.stryker-tmp\/sandbox-[^/\s]+\//gu;

/** The first non-empty line of an invalid mutant's error, with the runner checkout and Stryker
 * sandbox prefixes removed so paths are relative to the repository. Stryker writes
 * `<message> <stack>`, so a line `X TypeError: X` becomes `TypeError: X`. */
export function invalidReason(reason: string): string {
  const first =
    reason
      .split(/\r\n|[\n\r\u2028\u2029]/u)
      .map((line) => line.trim())
      .find(Boolean) ?? '';
  const line = first.replace(CHECKOUT, '').replace(SANDBOX, '');
  const repeated = /^(.+) ([A-Za-z]*Error): \1$/u.exec(line);
  return repeated ? `${repeated[2]}: ${repeated[1]}` : line;
}

/** Fenced code block; control characters other than newline and tab become `?`. */
export function codeBlock(content: string, language = ''): string {
  const clean = content.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, '?');
  const ticks = fence(clean);
  return `${ticks}${language}\n${clean}\n${ticks}`;
}

/** Text for an HTML context such as `<summary>`, where Markdown code spans do not render. */
export function escapeHtml(text: string): string {
  return text
    .replace(CONTROL, '?')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

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

/** Each path segment percent-encoded, parentheses included. */
export function encodePath(file: string): string {
  return file
    .split('/')
    .map((segment) => encodeParens(encodeURIComponent(segment)))
    .join('/');
}

export interface RenderOptions {
  /** `https://server/owner/repo`, the prefix for blob links to the tested commit. */
  repositoryUrl: string;
  head: string;
  /** Characters available to the sections; `Infinity` renders everything. */
  budget: number;
  /** Refactor hints shown before the rest are folded. */
  hints: number;
  /** The folded hints list only functions with at least this CRAP; the others are counted and
   * left to `report.md`. `undefined` folds every remaining function, as `report.md` does. */
  threshold?: number;
  /** Survivors shown on one line before "N more"; `Infinity` shows all. Default 3. */
  survivorsPerLine?: number;
}

/** Fails closed to the default on anything but an integer in [0, MAX_REFACTOR_HINTS]. */
export function resolveHints(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_REFACTOR_HINTS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > MAX_REFACTOR_HINTS) {
    console.warn(
      `Invalid QUALITY_REFACTOR_HINTS "${raw}"; using the default of ${DEFAULT_REFACTOR_HINTS}.`,
    );
    return DEFAULT_REFACTOR_HINTS;
  }
  return value;
}

/** Fails closed to the default on anything but an integer in [0, MAX_CRAP_THRESHOLD]. */
export function resolveThreshold(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_CRAP_THRESHOLD;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > MAX_CRAP_THRESHOLD) {
    console.warn(
      `Invalid QUALITY_CRAP_THRESHOLD "${raw}"; using the default of ${DEFAULT_CRAP_THRESHOLD}.`,
    );
    return DEFAULT_CRAP_THRESHOLD;
  }
  return value;
}

const plural = (count: number, one: string, many = `${one}s`): string =>
  `${count} ${count === 1 ? one : many}`;
const lines = (range: LineRange) => range.end - range.start + 1;
const rangeText = (range: LineRange) =>
  range.start === range.end ? `${range.start}` : `${range.start}-${range.end}`;
const lineLabel = (range: LineRange) =>
  `${range.start === range.end ? 'Line' : 'Lines'} ${rangeText(range)}`;
/** "3 more ranges", "1 more range". */
const moreOf = (count: number, unit: string) => `${count} more ${count === 1 ? unit : `${unit}s`}`;
const more = (count: number, unit: string) =>
  count > 0 ? `\n_${moreOf(count, unit)} in report.md._\n` : '';

function blob(options: RenderOptions, file: string, range: LineRange): string {
  const anchor = range.start === range.end ? `L${range.start}` : `L${range.start}-L${range.end}`;
  const root = safeLink(options.repositoryUrl) ?? '';
  return `${root}/blob/${options.head}/${encodePath(file)}#${anchor}`;
}

function language(file: string): string {
  const extension = /\.([a-z]+)$/u.exec(file)?.[1] ?? '';
  if (['ts', 'mts', 'cts', 'tsx'].includes(extension)) return 'ts';
  if (['js', 'mjs', 'cjs', 'jsx'].includes(extension)) return 'js';
  return '';
}

function details(summary: string, body: string): string {
  return `<details><summary>${summary}</summary>\n\n${body}\n\n</details>\n`;
}

/** A list rendered in rank order; `render(count)` writes its first `count` items. */
interface Slot {
  total: number;
  render(count: number): string;
}

const emptySlot: Slot = { total: 0, render: () => '' };

function largestFitting(slot: Slot, cap: number): number {
  if (slot.render(slot.total).length <= cap) return slot.total;
  let low = 0;
  let high = slot.total;
  while (low < high) {
    const mid = low + Math.ceil((high - low) / 2);
    if (slot.render(mid).length <= cap) low = mid;
    else high = mid - 1;
  }
  return low;
}

/** Water-fills `budget` across the slots: every slot that fits an equal share renders in full and
 * returns its unused share to the others; the rest are cut by rank to their share. A second pass
 * gives any characters a cut slot left unused to the slots after it. */
export function allocate(slots: Slot[], budget: number): number[] {
  const full = slots.map((slot) => slot.render(slot.total).length);
  const caps = new Array<number>(slots.length).fill(0);
  let open = slots.map((_, index) => index);
  let remaining = budget;
  while (open.length) {
    const share = Math.floor(remaining / open.length);
    const fits = open.filter((index) => full[index] <= share);
    if (!fits.length) {
      for (const index of open) caps[index] = share;
      break;
    }
    for (const index of fits) {
      caps[index] = full[index];
      remaining -= full[index];
    }
    open = open.filter((index) => !fits.includes(index));
  }
  const counts = slots.map((slot, index) => largestFitting(slot, caps[index]));
  let spare =
    budget - slots.reduce((total, slot, index) => total + slot.render(counts[index]).length, 0);
  for (const [index, slot] of slots.entries()) {
    if (counts[index] === slot.total || spare <= 0) continue;
    const used = slot.render(counts[index]).length;
    counts[index] = largestFitting(slot, used + spare);
    spare -= slot.render(counts[index]).length - used;
  }
  return counts;
}

interface Located<T> {
  workspace: Workspace;
  item: T;
}

const percent = (fraction: number) => `${(fraction * 100).toFixed(0)}%`;

function functionLink(fn: RiskFunction, options: RenderOptions): string {
  return `[${codeSpan(`${fn.file}:${fn.line}`, 500)}](${blob(options, fn.file, { start: fn.line, end: fn.line })})`;
}

/** One sentence from the summary counts and the highest-CRAP changed function. Unreliable
 * coverage makes both numbers a lower bound, so the line then says the data is incomplete. */
function riskTakeaway(risk: RiskSection[], options: RenderOptions): string {
  const missing = risk.filter((section) => section.status === 'unavailable').length;
  const failed = risk.filter((section) => section.status === 'failed').length;
  const unreliable = risk.reduce(
    (total, section) =>
      section.status === 'complete'
        ? total + section.summary.incomplete + section.summary.unavailable
        : total,
    0,
  );
  if (missing || failed || unreliable) {
    const parts = [
      ...(missing ? [`${plural(missing, 'workspace report')} unavailable`] : []),
      ...(failed ? [`${plural(failed, 'workspace')} with failing tests`] : []),
      ...(unreliable ? [`${plural(unreliable, 'file')} without reliable coverage`] : []),
    ];
    return `**Takeaway:** incomplete data (${parts.join('; ')}), so no summary is given.`;
  }
  const untested = risk.reduce((total, section) => total + section.summary.uncoveredLines, 0);
  const top = risk
    .flatMap((section) => section.functions)
    .filter((fn) => fn.crap !== null && fn.coverage !== null)
    .sort(
      (a, b) => (b.crap ?? 0) - (a.crap ?? 0) || a.file.localeCompare(b.file) || a.line - b.line,
    )[0];
  if (!untested && !top) return '';
  const lead = untested
    ? `${plural(untested, 'changed line')} ${untested === 1 ? 'has' : 'have'} no test.`
    : 'Every changed line has a test.';
  const highest = top
    ? ` Highest CRAP among changed functions: ${codeSpan(top.name, 200)} at ${functionLink(top, options)}, CRAP ${(top.crap ?? 0).toFixed(1)} with ${percent(top.coverage ?? 0)} coverage.`
    : '';
  return `**Takeaway:** ${lead}${highest}`;
}

/** "failed: 2 tests failed, 1 suite failed to run". */
function failureText(failure: NonNullable<RiskSection['failure']>): string {
  const parts = [
    ...(failure.failedTests ? [`${plural(failure.failedTests, 'test')} failed`] : []),
    ...(failure.failedSuites ? [`${plural(failure.failedSuites, 'suite')} failed to run`] : []),
  ];
  return `failed: ${parts.join(', ') || 'tests failed'}`;
}

function riskSummary(risk: RiskSection[], options: RenderOptions): string {
  const takeaway = riskTakeaway(risk, options);
  const rows = risk.map((section) => {
    if (section.status === 'unavailable')
      return `| ${section.workspace} | report unavailable | | | | |`;
    if (section.failure)
      return `| ${section.workspace} | ${failureText(section.failure)} | | | | |`;
    const { files, measured, incomplete, unavailable, uncoveredLines } = section.summary;
    const craps = section.functions.flatMap((fn) => (fn.crap === null ? [] : [fn.crap]));
    const top = craps.length ? Math.max(...craps).toFixed(1) : '–';
    return `| ${section.workspace} | ${measured} of ${files} | ${incomplete} | ${unavailable} | ${uncoveredLines} | ${top} |`;
  });
  return [
    '#### Change risk',
    '',
    ...(takeaway ? [takeaway, ''] : []),
    '| Workspace | Files measured | Incomplete | Unavailable | Changed lines with no test | Highest CRAP |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    ...rows,
    '',
  ].join('\n');
}

/** Failing tests of each `failed` workspace; suite paths and test names are untrusted text. */
function failureSlot(risk: RiskSection[]): Slot {
  const items: Located<FailedTest>[] = risk.flatMap((section) =>
    (section.failure?.tests ?? []).map((item) => ({ workspace: section.workspace, item })),
  );
  const recorded = risk.reduce(
    (total, section) =>
      total +
      (section.failure
        ? Math.max(
            0,
            section.failure.failedTests +
              section.failure.failedSuites -
              section.failure.tests.length,
          )
        : 0),
    0,
  );
  if (!items.length) return emptySlot;
  return {
    total: items.length,
    render(count) {
      const body = items.slice(0, count).map(({ workspace, item }) => {
        const name = item.test === null ? 'suite failed to run' : codeSpan(item.test, 200);
        return `- ${workspace}: ${codeSpan(item.suite, 500)} › ${name}`;
      });
      return details(
        'Failing tests',
        [
          ...body,
          more(items.length - count, 'failing test'),
          recorded ? `\n_${moreOf(recorded, 'failure')} in the job log._\n` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      );
    },
  };
}

function unmeasuredSlot(risk: RiskSection[]): Slot {
  const groups = new Map<string, Located<RiskFile>[]>();
  for (const section of risk) {
    for (const file of section.files) {
      if (file.state === 'measured') continue;
      const key = JSON.stringify([section.workspace, file.state, file.reasons]);
      groups.set(key, [...(groups.get(key) ?? []), { workspace: section.workspace, item: file }]);
    }
  }
  const items = [...groups.values()].sort((a, b) => b.length - a.length).flat();
  if (!items.length) return emptySlot;
  return {
    total: items.length,
    render(count) {
      const shown = new Map<string, Located<RiskFile>[]>();
      for (const entry of items.slice(0, count)) {
        const key = JSON.stringify([entry.workspace, entry.item.state, entry.item.reasons]);
        shown.set(key, [...(shown.get(key) ?? []), entry]);
      }
      const body = [...shown.values()].map((group) => {
        const [{ workspace, item }] = group;
        const reasons =
          item.reasons.map((reason) => codeSpan(reason, 300)).join('; ') || 'no reason given';
        return [
          `- **${item.state}** in ${workspace}: ${reasons}`,
          ...group.map((entry) => `  - ${codeSpan(entry.item.file, 500)}`),
        ].join('\n');
      });
      return details(
        `Incomplete or unavailable files (${items.length})`,
        [...body, more(items.length - count, 'file')].join('\n'),
      );
    },
  };
}

interface Gap {
  workspace: Workspace;
  file: string;
  range: LineRange;
  excerpt: string;
  fileLines: number;
}

function gapSlot(risk: RiskSection[], options: RenderOptions): Slot {
  const items: Gap[] = risk
    .flatMap((section) =>
      section.files.flatMap((file) => {
        const fileLines = file.gaps.reduce((total, gap) => total + lines(gap), 0);
        return file.gaps.map((gap) => ({
          workspace: section.workspace,
          file: file.file,
          range: { start: gap.start, end: gap.end },
          excerpt: gap.excerpt,
          fileLines,
        }));
      }),
    )
    .sort(
      (a, b) =>
        b.fileLines - a.fileLines || a.file.localeCompare(b.file) || a.range.start - b.range.start,
    );
  const omitted = risk.reduce((total, section) => total + section.omitted.files, 0);
  if (!items.length && !omitted) return emptySlot;
  return {
    total: items.length,
    render(count) {
      const byFile = new Map<string, Gap[]>();
      for (const gap of items.slice(0, count))
        byFile.set(gap.file, [...(byFile.get(gap.file) ?? []), gap]);
      const files = [...byFile.values()].map((gaps) =>
        details(
          `<code>${escapeHtml(gaps[0].file)}</code>: ${plural(gaps[0].fileLines, 'line')} (${gaps[0].workspace})`,
          gaps
            .map(
              (gap) =>
                `[${lineLabel(gap.range)}](${blob(options, gap.file, gap.range)})\n\n${codeBlock(gap.excerpt, language(gap.file))}`,
            )
            .join('\n\n'),
        ),
      );
      return [
        '**Changed lines with no test**',
        '',
        ...files,
        more(items.length - count, 'range') +
          (omitted
            ? `\n_${plural(omitted, 'file')} omitted from the findings file; see the risk reports._\n`
            : ''),
      ].join('\n');
    },
  };
}

function hintRow(entry: Located<RiskFunction>, options: RenderOptions): string {
  const fn = entry.item;
  const measured = fn.crap !== null && fn.coverage !== null;
  const state = fn.state ?? 'unavailable';
  const coverage = measured ? percent(fn.coverage ?? 0) : state;
  const crap = measured ? (fn.crap ?? 0).toFixed(1) : state;
  return row([codeSpan(fn.name, 200), fn.complexity, coverage, crap, functionLink(fn, options)]);
}

const HINT_HEADER = [
  '| Function | Complexity | Coverage | CRAP | Location |',
  '| --- | ---: | ---: | ---: | --- |',
];

function hintSlot(risk: RiskSection[], options: RenderOptions): Slot {
  const items = risk
    .flatMap((section) => section.functions.map((item) => ({ workspace: section.workspace, item })))
    .sort(
      (a, b) =>
        (b.item.crap ?? -1) - (a.item.crap ?? -1) ||
        b.item.complexity - a.item.complexity ||
        a.item.file.localeCompare(b.item.file) ||
        a.item.line - b.item.line,
    );
  if (!items.length) return emptySlot;
  const { threshold } = options;
  const top = Math.min(options.hints, items.length);
  // CRAP-descending order with unmeasured functions last, so the eligible ones follow the top.
  const eligible =
    threshold === undefined
      ? items.length - top
      : items.slice(top).filter(({ item }) => item.crap !== null && item.crap >= threshold).length;
  return {
    total: top + eligible,
    render(count) {
      const shown = items.slice(0, Math.min(count, top));
      const folded = items.slice(shown.length, count);
      const rest = items.slice(count);
      const label =
        threshold === undefined
          ? moreOf(folded.length, 'function')
          : `${moreOf(folded.length, 'function')} with CRAP ≥ ${threshold}`;
      const unscored = rest.some(({ item }) => item.crap === null);
      const remainder =
        threshold === undefined
          ? more(rest.length, 'function')
          : `\n_${moreOf(rest.length, 'function')} below the threshold${unscored ? ' or without a CRAP score' : ''} (or cut for size) ${rest.length === 1 ? 'is' : 'are'} in report.md._\n`;
      return [
        '**Refactor hints** (highest CRAP first)',
        '',
        ...(shown.length
          ? [...HINT_HEADER, ...shown.map((entry) => hintRow(entry, options)), '']
          : []),
        ...(folded.length
          ? [
              details(
                label,
                [...HINT_HEADER, ...folded.map((entry) => hintRow(entry, options))].join('\n'),
              ),
            ]
          : []),
        rest.length ? remainder : '',
        'CRAP = complexity² × (1 − coverage)³ + complexity',
        '',
      ].join('\n');
    },
  };
}

/** One sentence from the survivor count and the file with the most survivors. A run that did not
 * finish, or a findings file that dropped survivors, makes it say the data is incomplete. */
function mutationTakeaway(data: QualityFindings): string {
  const missing = data.mutation.filter((section) => section.status === 'unavailable').length;
  const partial = data.mutation.filter((section) => section.status === 'partial').length;
  const omitted = data.mutation.reduce((total, section) => total + section.omitted.findings, 0);
  if (missing || partial || omitted) {
    const parts = [
      ...(missing ? [`${plural(missing, 'workspace report')} unavailable`] : []),
      ...(partial ? [`${plural(partial, 'run')} stopped at the budget`] : []),
      ...(omitted ? [`${plural(omitted, 'survivor')} omitted from the findings file`] : []),
    ];
    return `**Takeaway:** incomplete data (${parts.join('; ')}), so no summary is given.`;
  }
  const survived = data.mutation.reduce((total, section) => total + section.counts.survived, 0);
  if (!survived) return '';
  const perFile = new Map<string, number>();
  for (const finding of data.mutation.flatMap((section) => section.findings))
    perFile.set(finding.file, (perFile.get(finding.file) ?? 0) + 1);
  const [file, count] =
    [...perFile].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] ?? [];
  const most = file === undefined ? '' : `; the most are in ${codeSpan(file, 500)} (${count})`;
  return `**Takeaway:** ${plural(survived, 'survivor')}${most}.`;
}

function mutationSummary(data: QualityFindings): string {
  const takeaway = mutationTakeaway(data);
  const rows = data.mutation.map((section) => {
    if (section.status === 'unavailable')
      return `| ${section.workspace} | | | | | | | | unavailable |`;
    const { killed, survived, timeout, noCoverage, invalid, ignored, pending } = section.counts;
    const score =
      section.scores.killedByAssertion === null
        ? '–'
        : `${section.scores.killedByAssertion.toFixed(1)}%${section.scores.stryker === null ? '' : ` (Stryker ${section.scores.stryker.toFixed(1)}%)`}`;
    const run =
      section.status === 'partial'
        ? `partial: budget reached, ${plural(pending, 'mutant')} not run`
        : 'complete';
    return `| ${section.workspace} | ${killed} | ${survived} | ${timeout} | ${noCoverage} | ${invalid} | ${ignored} | ${score} | ${run} |`;
  });
  return [
    '#### Mutation testing',
    '',
    ...(takeaway ? [takeaway, ''] : []),
    'Score: killed by assertion, Killed/(Killed+Survived+NoCoverage); the Stryker score also counts timeouts.',
    '',
    '| Workspace | Killed | Survived | Timeout | No coverage | Invalid | Ignored | Score | Run |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
    ...rows,
    '',
  ].join('\n');
}

interface SurvivorLine {
  file: string;
  line: number;
  rank: number;
  findings: Finding[];
}

/** One fenced `diff` block: the original lines once with `-`, then each survivor's mutated lines
 * with `+`. With several survivors, a `@@ Mutator @@` line comes before each one, and a survivor
 * that spans other lines than the first one repeats its own `-` lines. */
function survivorDiff(findings: Finding[]): string {
  const prefixed = (sign: string, text: string) => text.split('\n').map((line) => sign + line);
  const [first] = findings;
  const several = findings.length > 1;
  const body = [
    ...prefixed('-', first.source),
    ...findings.flatMap((finding) => [
      ...(several ? [`@@ ${finding.mutator} @@`] : []),
      ...(finding.source === first.source ? [] : prefixed('-', finding.source)),
      ...prefixed('+', finding.mutated),
    ]),
  ];
  return codeBlock(body.join('\n'), 'diff');
}

function survivorEntry(entry: SurvivorLine, options: RenderOptions): string {
  const shown = entry.findings.slice(0, options.survivorsPerLine ?? SURVIVORS_PER_LINE);
  const range = {
    start: entry.line,
    end: Math.max(...shown.map((finding) => finding.endLine)),
  };
  const tags = [...new Set(entry.findings.flatMap((finding) => finding.tags))].join(', ');
  const link = `[${lineLabel(range)}](${blob(options, entry.file, range)})`;
  const rest = entry.findings.length - shown.length;
  return [
    `${link} · ${tags} · ${plural(entry.findings.length, 'survivor')}`,
    '',
    survivorDiff(shown),
    ...(rest > 0 ? ['', `_${moreOf(rest, 'survivor')} on this line in report.md._`] : []),
  ].join('\n');
}

function survivorSlot(data: QualityFindings, options: RenderOptions): Slot {
  const findings = data.mutation.flatMap((section) => section.findings);
  const omitted = data.mutation.reduce((total, section) => total + section.omitted.findings, 0);
  if (!findings.length && !omitted) return emptySlot;
  const byLine = new Map<string, SurvivorLine>();
  for (const finding of findings) {
    const key = `${finding.file}\n${finding.line}`;
    const entry = byLine.get(key) ?? {
      file: finding.file,
      line: finding.line,
      rank: finding.rank,
      findings: [],
    };
    entry.findings.push(finding);
    entry.rank = Math.min(entry.rank, finding.rank);
    byLine.set(key, entry);
  }
  for (const entry of byLine.values()) entry.findings.sort((a, b) => a.rank - b.rank);
  const entries = [...byLine.values()].sort(
    (a, b) => a.rank - b.rank || a.file.localeCompare(b.file) || a.line - b.line,
  );
  const perFile = new Map<string, { lines: number; survivors: number }>();
  for (const entry of entries) {
    const totals = perFile.get(entry.file) ?? { lines: 0, survivors: 0 };
    totals.lines += 1;
    totals.survivors += entry.findings.length;
    perFile.set(entry.file, totals);
  }
  return {
    total: entries.length,
    render(count) {
      // Files follow their best-ranked shown line; lines within a file keep rank order.
      const byFile = new Map<string, SurvivorLine[]>();
      for (const entry of entries.slice(0, count))
        byFile.set(entry.file, [...(byFile.get(entry.file) ?? []), entry]);
      const shown = entries
        .slice(0, count)
        .reduce((total, entry) => total + entry.findings.length, 0);
      const files = [...byFile].map(([file, group]) => {
        const totals = perFile.get(file)!;
        return details(
          `<code>${escapeHtml(file)}</code>: ${plural(totals.survivors, 'survivor')} on ${plural(totals.lines, 'line')}`,
          group.map((entry) => survivorEntry(entry, options)).join('\n\n'),
        );
      });
      return [
        '**Survivors** (tests still passed after this change to the code; not confirmed bugs), most important first',
        '',
        ...files,
        more(findings.length + omitted - shown, 'survivor'),
      ].join('\n');
    },
  };
}

function noCoverageSlot(data: QualityFindings, options: RenderOptions): Slot {
  const items = data.mutation.flatMap((section) =>
    section.noCoverage.flatMap(({ file, ranges }) => ranges.map((range) => ({ file, range }))),
  );
  const omitted = data.mutation.reduce((total, section) => total + section.omitted.noCoverage, 0);
  if (!items.length && !omitted) return emptySlot;
  return {
    total: items.length,
    render(count) {
      const byFile = new Map<string, LineRange[]>();
      for (const { file, range } of items.slice(0, count))
        byFile.set(file, [...(byFile.get(file) ?? []), range]);
      const body = [...byFile].map(
        ([file, ranges]) =>
          `- ${codeSpan(file, 500)}: ${ranges.map((range) => `[${rangeText(range)}](${blob(options, file, range)})`).join(', ')}`,
      );
      return details(
        `Changed lines that no test executed during mutation testing (${plural(items.length, 'range')})`,
        [
          ...body,
          more(items.length - count, 'range'),
          omitted ? `_${plural(omitted, 'file')} omitted from the findings file._` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      );
    },
  };
}

function invalidRow(item: InvalidFinding, options: RenderOptions): string {
  const link = `[${codeSpan(`${item.file}:${item.line}:${item.column}`, 500)}](${blob(options, item.file, { start: item.line, end: item.line })})`;
  return row([
    link,
    item.mutator,
    `${sourceSpan(item.original)} → ${sourceSpan(item.replacement)}`,
    codeSpan(invalidReason(item.reason) || item.status, 200),
  ]);
}

function invalidSlot(data: QualityFindings, options: RenderOptions): Slot {
  const items = data.mutation.flatMap((section) => section.invalid);
  const omitted = data.mutation.reduce((total, section) => total + section.omitted.invalid, 0);
  if (!items.length && !omitted) return emptySlot;
  return {
    total: items.length,
    render(count) {
      return details(
        `Invalid mutants, excluded from the score (${items.length + omitted})`,
        [
          '| Location | Mutator | Original → mutated | Reason |',
          '| --- | --- | --- | --- |',
          ...items.slice(0, count).map((item) => invalidRow(item, options)),
          more(items.length + omitted - count, 'mutant'),
        ].join('\n'),
      );
    },
  };
}

/** The change-risk and mutation sections of the report comment and of `report.md`. Lists are cut
 * by rank to fit `options.budget`, each with an "N more ... in report.md" marker; the fixed summary
 * tables are never cut. */
export function renderSections(data: QualityFindings, options: RenderOptions): string {
  const fixed: string[] = [];
  const slots: Slot[] = [];
  const order: (number | string)[] = [];
  const add = (slot: Slot) => {
    order.push(slots.length);
    slots.push(slot);
  };
  const text = (value: string) => {
    order.push(value);
    fixed.push(value);
  };
  if (data.risk.length) {
    text(riskSummary(data.risk, options));
    add(failureSlot(data.risk));
    add(unmeasuredSlot(data.risk));
    add(gapSlot(data.risk, options));
    add(hintSlot(data.risk, options));
  }
  if (data.mutation.length) {
    text(mutationSummary(data));
    add(survivorSlot(data, options));
    add(noCoverageSlot(data, options));
    add(invalidSlot(data, options));
  }
  const fixedLength = fixed.reduce((total, value) => total + value.length + 1, 0);
  const counts = allocate(slots, Math.max(0, options.budget - fixedLength - order.length));
  return order
    .map((part) => (typeof part === 'string' ? part : slots[part].render(counts[part])))
    .filter(Boolean)
    .join('\n');
}
