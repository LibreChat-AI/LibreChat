/** Edit features a worker may negotiate; LibreChat only sends a feature's fields once advertised. */
export type WorkspaceEditFileFeature = 'expected_base_sha256' | 'tolerant_match' | 'replace_all';

export const WORKSPACE_EDIT_FILE_FEATURES: readonly WorkspaceEditFileFeature[] = [
  'expected_base_sha256',
  'tolerant_match',
  'replace_all',
];

/** `tolerant` lets the worker fall back from exact matching to whitespace-tolerant strategies. */
export type WorkspaceEditMatching = 'exact' | 'tolerant';

export type WorkspaceEditMatchStrategy =
  | 'exact'
  | 'line-trimmed'
  | 'whitespace-normalized'
  | 'indentation-flexible';

export const WORKSPACE_EDIT_MATCH_STRATEGIES: ReadonlySet<string> =
  new Set<WorkspaceEditMatchStrategy>([
    'exact',
    'line-trimmed',
    'whitespace-normalized',
    'indentation-flexible',
  ]);

/** How one edit matched; reported only for requests that set `matching` or `replaceAll`. */
export interface WorkspaceEditMatch {
  strategy: WorkspaceEditMatchStrategy;
  occurrences: number;
}

export type EditConflictHint =
  | { kind: 'elision' }
  | { kind: 'line_numbers' }
  | { kind: 'crlf' }
  | { kind: 'whitespace'; line: number; strategy: WorkspaceEditMatchStrategy }
  | { kind: 'first_line'; lines: number[]; more: number }
  | { kind: 'closest_line'; line: number };

/** How a quoted file line compares with the `old_text` line at the same position. */
export type EditConflictExcerptMark = 'same' | 'whitespace' | 'changed';

/** The current text of the region a missing edit most likely meant, as the worker quoted it. */
export interface EditConflictExcerpt {
  firstLine: number;
  lines: Array<{ mark: EditConflictExcerptMark; text: string }>;
}

export type EditConflictFailure =
  | { edit: number; kind: 'not_found'; hints: EditConflictHint[]; excerpt?: EditConflictExcerpt }
  | {
      edit: number;
      kind: 'ambiguous';
      count: number;
      strategy: WorkspaceEditMatchStrategy;
      lines: number[];
      more: number;
    }
  | { edit: number; kind: 'repetitive' };

/** The facts LibreChat accepts from a worker's `EDIT_CONFLICT` explanation. */
export interface EditConflictReport {
  editCount: number;
  failures: EditConflictFailure[];
  hidden: number;
}

const MAX_CONFLICT_EDITS = 100;
const MAX_CONFLICT_LINES = 5;
const MAX_CONFLICT_MESSAGE_CHARS = 8_192;
const MAX_EXCERPT_LINES = 8;
/** The worker shortens each quoted line to 160 characters plus an ellipsis. */
const MAX_EXCERPT_LINE_CHARS = 161;

const SINGLE_HEADER = /^Workspace edit did not apply and nothing was written: ([\s\S]+)\.$/;
const BATCH_HEADER =
  /^(\d{1,3}) of (\d{1,3}) workspace edits did not apply, so nothing was written\. Every other edit matched\.$/;
const BATCH_EDIT = /^Edit (\d{1,3}): (.+)\.$/;
const BATCH_HIDDEN = /^(\d{1,3}) more failing edits? not shown\.$/;
const BATCH_LINE_NOTE = 'Line numbers account for the earlier edits in this batch.';
const STRATEGY = '(exact|line-trimmed|whitespace-normalized|indentation-flexible)';
const LINE_LIST = '(?:line|lines) ((?:\\d{1,9}, ){0,4}\\d{1,9})(?: and (\\d{1,9}) more)?';
const JSON_STRING = '("(?:[^"\\\\]|\\\\.)*")';
const AMBIGUOUS = new RegExp(
  `^old_text matched (\\d{1,9}) locations(?: \\(${STRATEGY}\\))? at ${LINE_LIST}; include more surrounding lines so it matches exactly one$`,
);
const REPETITIVE =
  'old_text has too many repetitive line-window candidates; include more surrounding lines or use an exact match';
const NOT_FOUND = 'old_text was not found';
/** Always the last hint; its JSON string holds `<line>|<mark><text>` rows. */
const EXCERPT = new RegExp(
  `^the current text at (?:line (\\d{1,9})|lines (\\d{1,9})-(\\d{1,9})) \\(~ whitespace differs, ! text differs\\) is ${JSON_STRING}$`,
);
const EXCERPT_ROW = /^(\d{1,9})\|([ ~!])(.*)$/;
const EXCERPT_MARKS: Readonly<Record<string, EditConflictExcerptMark>> = {
  ' ': 'same',
  '~': 'whitespace',
  '!': 'changed',
};

type HintParser = [RegExp, (match: RegExpExecArray) => EditConflictHint, { last?: boolean }?];

const HINT_PARSERS: HintParser[] = [
  [
    /^it contains an elision placeholder \("\.\.\."\); copy the exact lines instead of abbreviating(?:; |$)/,
    () => ({ kind: 'elision' }),
  ],
  [
    /^it appears to include line-number prefixes from read_file output; remove them(?:; |$)/,
    () => ({ kind: 'line_numbers' }),
  ],
  [
    new RegExp(
      `^the same text exists at line (\\d{1,9}) with different whitespace \\(${STRATEGY}\\); copy that whitespace exactly(?:; |$)`,
    ),
    (match) => ({
      kind: 'whitespace',
      line: Number(match[1]),
      strategy: match[2] as WorkspaceEditMatchStrategy,
    }),
  ],
  [/^the file uses CRLF line endings(?:; |$)/, () => ({ kind: 'crlf' })],
  [
    new RegExp(`^its first line appears at ${LINE_LIST}, but the lines after it differ(?:; |$)`),
    (match) => ({ kind: 'first_line', lines: parseLines(match[1]), more: Number(match[2] ?? 0) }),
  ],
  /** The quoted line is never kept; a complete quote lets a later excerpt be read. */
  [
    new RegExp(`^the closest line is line (\\d{1,9}): ${JSON_STRING}(?:; |$)`),
    (match) => ({ kind: 'closest_line', line: Number(match[1]) }),
  ],
  /** A quote that is not a complete JSON string ends the hints it can be told apart from. */
  [
    /^the closest line is line (\d{1,9}): /,
    (match) => ({ kind: 'closest_line', line: Number(match[1]) }),
    { last: true },
  ],
];

function parseLines(value: string): number[] {
  return value.split(', ').slice(0, MAX_CONFLICT_LINES).map(Number);
}

/** Characters that could break a quoted line out of its row; tabs are ordinary source text. */
function hasUnsafeCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if ((code < 0x20 && code !== 0x09) || code === 0x7f || code === 0x2028 || code === 0x2029) {
      return true;
    }
  }
  return false;
}

function decodeJsonString(value: string): string | undefined {
  try {
    const decoded: unknown = JSON.parse(value);
    return typeof decoded === 'string' ? decoded : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Accepts the worker's excerpt only when every row is well formed: contiguous line numbers
 * matching the stated range, a known mark, and a bounded single line of text.
 */
function parseExcerpt(match: RegExpExecArray): EditConflictExcerpt | undefined {
  const firstLine = Number(match[1] ?? match[2]);
  const lastLine = Number(match[1] ?? match[3]);
  const decoded = decodeJsonString(match[4]);
  if (decoded == null || lastLine < firstLine || lastLine - firstLine >= MAX_EXCERPT_LINES) {
    return undefined;
  }
  const rows = decoded.split('\n');
  if (rows.length !== lastLine - firstLine + 1) return undefined;
  const lines: EditConflictExcerpt['lines'] = [];
  for (const [offset, row] of rows.entries()) {
    const parsed = EXCERPT_ROW.exec(row);
    if (
      !parsed ||
      Number(parsed[1]) !== firstLine + offset ||
      parsed[3].length > MAX_EXCERPT_LINE_CHARS ||
      hasUnsafeCharacter(parsed[3])
    ) {
      return undefined;
    }
    lines.push({ mark: EXCERPT_MARKS[parsed[2]], text: parsed[3] });
  }
  return { firstLine, lines };
}

function parseHints(value: string): { hints: EditConflictHint[]; excerpt?: EditConflictExcerpt } {
  const hints: EditConflictHint[] = [];
  let rest = value;
  while (rest.length > 0 && hints.length < HINT_PARSERS.length) {
    const excerptMatch = EXCERPT.exec(rest);
    if (excerptMatch) {
      const excerpt = parseExcerpt(excerptMatch);
      return excerpt ? { hints, excerpt } : { hints };
    }
    const parsed = HINT_PARSERS.map(([pattern, build, options]) => {
      const match = pattern.exec(rest);
      return match ? { match, hint: build(match), last: options?.last === true } : undefined;
    }).find((candidate) => candidate != null);
    if (!parsed) break;
    hints.push(parsed.hint);
    if (parsed.last) break;
    rest = rest.slice(parsed.match[0].length);
  }
  return { hints };
}

function parseReason(edit: number, reason: string): EditConflictFailure | undefined {
  const ambiguous = AMBIGUOUS.exec(reason);
  if (ambiguous) {
    return {
      edit,
      kind: 'ambiguous',
      count: Number(ambiguous[1]),
      strategy: (ambiguous[2] as WorkspaceEditMatchStrategy | undefined) ?? 'exact',
      lines: parseLines(ambiguous[3]),
      more: Number(ambiguous[4] ?? 0),
    };
  }
  if (reason === REPETITIVE) return { edit, kind: 'repetitive' };
  if (reason === NOT_FOUND) return { edit, kind: 'not_found', hints: [] };
  if (!reason.startsWith(`${NOT_FOUND}; `)) return undefined;
  return { edit, kind: 'not_found', ...parseHints(reason.slice(NOT_FOUND.length + 2)) };
}

/**
 * Recovers the facts in a worker's `EDIT_CONFLICT` message, or `undefined` when any part of it
 * falls outside the grammar current workers produce. Free text, including the line a
 * closest-line hint quotes, is never retained; the only file text kept is a well-formed
 * current-text excerpt, which callers treat as file content.
 */
export function parseEditConflict(message: string): EditConflictReport | undefined {
  if (message.length > MAX_CONFLICT_MESSAGE_CHARS) return undefined;
  const single = SINGLE_HEADER.exec(message);
  if (single) {
    const failure = parseReason(1, single[1]);
    return failure ? { editCount: 1, failures: [failure], hidden: 0 } : undefined;
  }
  const [header, ...lines] = message.split('\n');
  const batch = BATCH_HEADER.exec(header);
  if (!batch) return undefined;
  const failed = Number(batch[1]);
  const editCount = Number(batch[2]);
  if (editCount < 2 || editCount > MAX_CONFLICT_EDITS || failed < 1 || failed > editCount) {
    return undefined;
  }
  const failures: EditConflictFailure[] = [];
  let hidden = 0;
  for (const line of lines) {
    const edit = BATCH_EDIT.exec(line);
    if (edit) {
      const index = Number(edit[1]);
      const failure = index >= 1 && index <= editCount ? parseReason(index, edit[2]) : undefined;
      if (!failure) return undefined;
      failures.push(failure);
      continue;
    }
    const more = BATCH_HIDDEN.exec(line);
    if (more) {
      hidden = Number(more[1]);
      continue;
    }
    if (line !== BATCH_LINE_NOTE) return undefined;
  }
  if (failures.length === 0 || failures.length + hidden !== failed) return undefined;
  return { editCount, failures, hidden };
}

/** Every excerpt line in a report, for content inspection before it reaches the model. */
export function editConflictExcerptText(report: EditConflictReport): string {
  return report.failures
    .flatMap((failure) =>
      failure.kind === 'not_found' && failure.excerpt
        ? failure.excerpt.lines.map((line) => line.text)
        : [],
    )
    .join('\n');
}

function formatLines(lines: readonly number[], more: number): string {
  const label = lines.length === 1 && more === 0 ? 'line' : 'lines';
  return `${label} ${lines.join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
}

function formatHint(hint: EditConflictHint): string {
  switch (hint.kind) {
    case 'elision':
      return 'it contains an elided "..." line; copy the exact lines instead';
    case 'line_numbers':
      return 'it includes read_file line-number prefixes; remove them';
    case 'crlf':
      return 'the file uses CRLF line endings';
    case 'whitespace':
      return `the same text is at line ${hint.line} with different whitespace; copy that whitespace exactly`;
    case 'first_line':
      return `its first line is at ${formatLines(hint.lines, hint.more)}, but the lines after it differ`;
    case 'closest_line':
      return `the closest line is line ${hint.line}`;
  }
}

function excerptLinesWith(excerpt: EditConflictExcerpt, mark: EditConflictExcerptMark): number[] {
  return excerpt.lines.flatMap((line, offset) =>
    line.mark === mark ? [excerpt.firstLine + offset] : [],
  );
}

function describeExcerptLines(lines: readonly number[], what: string): string | undefined {
  if (lines.length === 0) return undefined;
  const shown = lines.slice(0, MAX_CONFLICT_LINES);
  const verb = lines.length === 1 ? 'differs' : 'differ';
  return `${formatLines(shown, lines.length - shown.length)} ${verb}${what}`;
}

/** Names the quoted region and which of its lines differ, from the excerpt's marks alone. */
function summarizeExcerpt(excerpt: EditConflictExcerpt): string {
  const lastLine = excerpt.firstLine + excerpt.lines.length - 1;
  const where =
    lastLine === excerpt.firstLine
      ? `line ${excerpt.firstLine}`
      : `lines ${excerpt.firstLine}-${lastLine}`;
  const differences = [
    describeExcerptLines(excerptLinesWith(excerpt, 'changed'), ''),
    describeExcerptLines(excerptLinesWith(excerpt, 'whitespace'), ' only in whitespace'),
  ].filter((part): part is string => part != null);
  return `the closest match is at ${where}${differences.length > 0 ? `, where ${differences.join(' and ')}` : ''}; correct old_text against the current text below (it may leave out lines or shorten them with "…"; read_file shows them in full)`;
}

const EXCERPT_GUTTER: Readonly<Record<EditConflictExcerptMark, string>> = {
  same: ' ',
  whitespace: '~',
  changed: '!',
};

/** Numbered like read_file output, with a leading column marking the lines that differ. */
function formatExcerpt(excerpt: EditConflictExcerpt, label: string): string {
  const width = String(excerpt.firstLine + excerpt.lines.length - 1).length;
  const rows = excerpt.lines.map(
    (line, offset) =>
      `${EXCERPT_GUTTER[line.mark]} ${String(excerpt.firstLine + offset).padStart(width, ' ')} | ${line.text}`,
  );
  return [`${label} (! text differs, ~ only whitespace differs):`, ...rows].join('\n');
}

function formatFailure(failure: EditConflictFailure, withExcerpt: boolean): string {
  if (failure.kind === 'ambiguous') {
    const how = failure.strategy === 'exact' ? '' : ` (${failure.strategy})`;
    return `old_text matched ${failure.count} locations${how} at ${formatLines(failure.lines, failure.more)}; include more surrounding lines, or set replace_all to change every location`;
  }
  if (failure.kind === 'repetitive') {
    return 'old_text matches too many repetitive line windows; include more surrounding lines';
  }
  const hints = failure.hints.map(formatHint);
  if (withExcerpt && failure.excerpt) hints.push(summarizeExcerpt(failure.excerpt));
  return `old_text was not found${hints.length > 0 ? `; ${hints.join('; ')}` : ''}`;
}

function failureExcerpt(failure: EditConflictFailure): EditConflictExcerpt | undefined {
  return failure.kind === 'not_found' ? failure.excerpt : undefined;
}

/**
 * LibreChat's own account of a rejected edit, built only from parsed facts. With
 * `withExcerpts`, each quoted region follows its edit as a numbered block of file text; leave
 * it off for any copy of the message that is logged.
 */
export function formatEditConflict(
  path: string,
  report: EditConflictReport,
  withExcerpts = false,
): string {
  if (report.editCount === 1) {
    const [failure] = report.failures;
    const excerpt = withExcerpts ? failureExcerpt(failure) : undefined;
    const sentence = `The edit to "${path}" did not apply, so nothing was written: ${formatFailure(failure, withExcerpts)}.`;
    return excerpt ? `${sentence}\n${formatExcerpt(excerpt, 'Current text')}` : sentence;
  }
  const failed = report.failures.length + report.hidden;
  const lines = [
    `${failed} of ${report.editCount} edits to "${path}" did not apply, so nothing was written; every other edit matched.`,
  ];
  for (const failure of report.failures) {
    lines.push(`Edit ${failure.edit}: ${formatFailure(failure, withExcerpts)}.`);
    const excerpt = withExcerpts ? failureExcerpt(failure) : undefined;
    if (excerpt) lines.push(formatExcerpt(excerpt, `Current text for edit ${failure.edit}`));
  }
  if (report.hidden > 0) {
    lines.push(`${report.hidden} more failing edit${report.hidden === 1 ? '' : 's'} not shown.`);
  }
  if (report.failures.some((failure) => failure.edit > 1)) {
    lines.push('Line numbers account for the earlier edits in this batch.');
  }
  return lines.join('\n');
}
