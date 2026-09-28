import { cn } from '~/utils';

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export interface DiffLine {
  type: 'add' | 'del' | 'context' | 'hunk';
  text: string;
  oldLine?: number;
  newLine?: number;
}

export interface ParsedDiff {
  lines: DiffLine[];
  additions: number;
  deletions: number;
  hasLineNumbers: boolean;
}

/**
 * Parses REAL unified-diff text (a tool's own output) into typed lines with
 * old/new line numbers when the hunk headers carry them. File headers and
 * `\ No newline` markers are dropped, since the window header already names
 * the file.
 *
 * Deliberately knows nothing about the args preview. That preview is built
 * from structured edits by `buildEditPreviewDiff`, so it never round-trips
 * through diff text: there are no synthetic separators to recognize, and
 * therefore no byte sequence a real changed line could be mistaken for. An
 * earlier version emitted `--- old_text` / `+++ new_text` separators and tried
 * to spot them here, which could not be made safe, because replacing a source
 * line `-- old_text` with `++ new_text` produces exactly those strings.
 */
export function parseUnifiedDiff(diff: string): ParsedDiff {
  const lines: DiffLine[] = [];
  let additions = 0;
  let deletions = 0;
  let hasLineNumbers = false;
  let oldLine: number | undefined;
  let newLine: number | undefined;
  let inHunk = false;

  for (const raw of diff.replace(/\n$/, '').split('\n')) {
    if (!inHunk && (raw.startsWith('--- ') || raw.startsWith('+++ '))) {
      continue;
    }
    if (raw.startsWith('\\')) {
      continue;
    }
    const hunk = HUNK_HEADER.exec(raw);
    if (hunk) {
      inHunk = true;
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      hasLineNumbers = true;
      lines.push({ type: 'hunk', text: raw });
      continue;
    }
    if (raw === '@@') {
      inHunk = true;
      oldLine = undefined;
      newLine = undefined;
      lines.push({ type: 'hunk', text: '' });
      continue;
    }
    if (raw.startsWith('+')) {
      additions += 1;
      lines.push({ type: 'add', text: raw.slice(1), newLine });
      newLine = newLine == null ? undefined : newLine + 1;
      continue;
    }
    if (raw.startsWith('-')) {
      deletions += 1;
      lines.push({ type: 'del', text: raw.slice(1), oldLine });
      oldLine = oldLine == null ? undefined : oldLine + 1;
      continue;
    }
    lines.push({
      type: 'context',
      text: raw.startsWith(' ') ? raw.slice(1) : raw,
      oldLine,
      newLine,
    });
    oldLine = oldLine == null ? undefined : oldLine + 1;
    newLine = newLine == null ? undefined : newLine + 1;
  }

  return { lines, additions, deletions, hasLineNumbers };
}

export interface TextEditPreview {
  oldText: string;
  newText: string;
}

/**
 * Rows one side of an edit contributes. An empty side means "nothing here",
 * not one blank line, and a trailing newline terminates the last line rather
 * than starting an empty one: plain `split('\n')` would render a blank row and
 * count it as a change, so a pure deletion (`new_text: ""`) claimed one
 * addition.
 */
const previewRows = (text: string): string[] => (text ? text.replace(/\n$/, '').split('\n') : []);

/**
 * Builds the diff for an `edit_file` args preview straight from the structured
 * edits, instead of formatting them into diff text for `parseUnifiedDiff` to
 * read back.
 *
 * That round trip is what made batched previews ambiguous: the separators it
 * needed between edits were byte-identical to a real changed line, since
 * deleting a source line `-- old_text` prefixes to exactly `--- old_text`. No
 * parser can tell those apart from position or bytes alone. Built here, each
 * edit boundary is structural and no separator is ever emitted.
 *
 * A boundary between edits becomes an empty `hunk` line, which `DiffView`
 * renders as its divider rule. There are no line numbers: args previews carry
 * the replacement text, never its position in the file.
 */
export function buildEditPreviewDiff(edits: TextEditPreview[]): ParsedDiff {
  const lines: DiffLine[] = [];
  let additions = 0;
  let deletions = 0;

  edits.forEach((edit, index) => {
    if (index > 0) {
      lines.push({ type: 'hunk', text: '' });
    }
    for (const text of previewRows(edit.oldText)) {
      deletions += 1;
      lines.push({ type: 'del', text });
    }
    for (const text of previewRows(edit.newText)) {
      additions += 1;
      lines.push({ type: 'add', text });
    }
  });

  return { lines, additions, deletions, hasLineNumbers: false };
}

/** One-way serialization for the copy button. Never parsed back, so it is free
 *  to be lossy about hunk boundaries. */
export function diffPreviewText(parsed: ParsedDiff): string {
  return parsed.lines
    .map((line) => (line.type === 'hunk' ? '' : `${LINE_MARKERS[line.type]}${line.text}`))
    .join('\n');
}

const LINE_MARKERS: Record<DiffLine['type'], string> = {
  add: '+',
  del: '-',
  context: '',
  hunk: '',
};

/** One number per row keeps the gutter compact: the old line for removals
 *  (it no longer exists in the new file) and the new line otherwise. */
function lineNumber(line: DiffLine): number | undefined {
  return line.type === 'del' ? line.oldLine : (line.newLine ?? line.oldLine);
}

export default function DiffView({ parsed }: { parsed: ParsedDiff }) {
  const { lines, hasLineNumbers } = parsed;
  const firstContentIndex = lines.findIndex((line) => line.type !== 'hunk');

  return (
    <div
      data-testid="diff-view"
      className="max-h-[300px] overflow-y-auto bg-surface-code py-2 font-mono text-xs leading-5"
    >
      {lines.map((line, index) => {
        if (line.type === 'hunk') {
          if (index < firstContentIndex || firstContentIndex === -1) {
            return null;
          }
          if (!line.text) {
            return <div key={index} className="mx-3 my-1.5 border-t border-border-light" />;
          }
          return (
            <div key={index} className="select-none px-3 py-0.5 text-[11px] text-text-tertiary">
              {line.text}
            </div>
          );
        }
        return (
          <div
            key={index}
            className={cn(
              'flex',
              line.type === 'add' && 'bg-status-success-subtle',
              line.type === 'del' && 'bg-status-error-subtle',
            )}
          >
            {hasLineNumbers && (
              <span className="w-9 shrink-0 select-none pr-1 text-right text-[11px] text-text-tertiary">
                {lineNumber(line) ?? ''}
              </span>
            )}
            <span
              className={cn(
                'shrink-0 select-none text-center font-semibold',
                hasLineNumbers ? 'w-5' : 'w-6',
                line.type === 'add' && 'text-status-success',
                line.type === 'del' && 'text-status-error',
              )}
            >
              {LINE_MARKERS[line.type]}
            </span>
            <span className="min-w-0 flex-1 whitespace-pre-wrap break-words pr-3 text-text-primary">
              {line.text || ' '}
            </span>
          </div>
        );
      })}
    </div>
  );
}
