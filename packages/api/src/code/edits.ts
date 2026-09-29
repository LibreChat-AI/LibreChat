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

export type EditConflictFailure =
  | { edit: number; kind: 'not_found'; hints: EditConflictHint[] }
  | {
      edit: number;
      kind: 'ambiguous';
      count: number;
      strategy: WorkspaceEditMatchStrategy;
      lines: number[];
      more: number;
    };

/** The facts LibreChat accepts from a worker's `EDIT_CONFLICT` explanation. */
export interface EditConflictReport {
  editCount: number;
  failures: EditConflictFailure[];
  hidden: number;
}

const MAX_CONFLICT_EDITS = 100;
const MAX_CONFLICT_LINES = 5;
const MAX_CONFLICT_MESSAGE_CHARS = 8_192;

const SINGLE_HEADER = /^Workspace edit did not apply and nothing was written: ([\s\S]+)\.$/;
const BATCH_HEADER =
  /^(\d{1,3}) of (\d{1,3}) workspace edits did not apply, so nothing was written\. Every other edit matched\.$/;
const BATCH_EDIT = /^Edit (\d{1,3}): (.+)\.$/;
const BATCH_HIDDEN = /^(\d{1,3}) more failing edits? not shown\.$/;
const BATCH_LINE_NOTE = 'Line numbers account for the earlier edits in this batch.';
const STRATEGY = '(exact|line-trimmed|whitespace-normalized|indentation-flexible)';
const LINE_LIST = '(?:line|lines) ((?:\\d{1,9}, ){0,4}\\d{1,9})(?: and (\\d{1,9}) more)?';
const AMBIGUOUS = new RegExp(
  `^old_text matched (\\d{1,9}) locations(?: \\(${STRATEGY}\\))? at ${LINE_LIST}; include more surrounding lines so it matches exactly one$`,
);
const NOT_FOUND = 'old_text was not found';
const HINT_PARSERS: Array<[RegExp, (match: RegExpExecArray) => EditConflictHint | undefined]> = [
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
  /** Its trailing excerpt is file content, so only the line number is kept. */
  [
    /^the closest line is line (\d{1,9}): /,
    (match) => ({ kind: 'closest_line', line: Number(match[1]) }),
  ],
];

function parseLines(value: string): number[] {
  return value.split(', ').slice(0, MAX_CONFLICT_LINES).map(Number);
}

function parseHints(value: string): EditConflictHint[] {
  const hints: EditConflictHint[] = [];
  let rest = value;
  while (rest.length > 0 && hints.length < HINT_PARSERS.length) {
    const parsed = HINT_PARSERS.map(([pattern, build]) => {
      const match = pattern.exec(rest);
      return match ? { match, hint: build(match) } : undefined;
    }).find((candidate) => candidate?.hint != null);
    if (!parsed?.hint) break;
    hints.push(parsed.hint);
    if (parsed.hint.kind === 'closest_line') break;
    rest = rest.slice(parsed.match[0].length);
  }
  return hints;
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
  if (reason === NOT_FOUND) return { edit, kind: 'not_found', hints: [] };
  if (!reason.startsWith(`${NOT_FOUND}; `)) return undefined;
  return { edit, kind: 'not_found', hints: parseHints(reason.slice(NOT_FOUND.length + 2)) };
}

/**
 * Recovers the facts in a worker's `EDIT_CONFLICT` message, or `undefined` when any part of it
 * falls outside the grammar current workers produce. Free text, including the file excerpt a
 * closest-line hint quotes, is never retained.
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

function formatFailure(failure: EditConflictFailure): string {
  if (failure.kind === 'ambiguous') {
    const how = failure.strategy === 'exact' ? '' : ` (${failure.strategy})`;
    return `old_text matched ${failure.count} locations${how} at ${formatLines(failure.lines, failure.more)}; include more surrounding lines, or set replace_all to change every location`;
  }
  const hints = failure.hints.map(formatHint);
  return `old_text was not found${hints.length > 0 ? `; ${hints.join('; ')}` : ''}`;
}

/** LibreChat's own account of a rejected edit, built only from parsed facts. */
export function formatEditConflict(path: string, report: EditConflictReport): string {
  if (report.editCount === 1) {
    return `The edit to "${path}" did not apply, so nothing was written: ${formatFailure(report.failures[0])}.`;
  }
  const failed = report.failures.length + report.hidden;
  const lines = [
    `${failed} of ${report.editCount} edits to "${path}" did not apply, so nothing was written; every other edit matched.`,
    ...report.failures.map((failure) => `Edit ${failure.edit}: ${formatFailure(failure)}.`),
  ];
  if (report.hidden > 0) {
    lines.push(`${report.hidden} more failing edit${report.hidden === 1 ? '' : 's'} not shown.`);
  }
  if (report.failures.some((failure) => failure.edit > 1)) {
    lines.push('Line numbers account for the earlier edits in this batch.');
  }
  return lines.join('\n');
}
