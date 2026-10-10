import type { TextEdit } from '../edits';

export interface HostEditWorkLimits {
  maxEdits: number;
  maxWorkBytes: number;
  maxOccurrences: number;
  maxOutputBytes: number;
}

export interface HostEditResult {
  content: string;
  strategies: string[];
}

export class HostEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostEditError';
  }
}

class EditWorkBudget {
  private bytes = 0;
  private occurrences = 0;

  constructor(private readonly limits: HostEditWorkLimits) {}

  scan(bytes: number): void {
    this.bytes += bytes;
    if (this.bytes > this.limits.maxWorkBytes) {
      throw new HostEditError(
        'File edit processing budget exceeded; split the batch. Nothing was written.',
      );
    }
  }

  occurrence(): void {
    if (++this.occurrences > this.limits.maxOccurrences) {
      throw new HostEditError(
        'File edit occurrence budget exceeded; narrow the replacements. Nothing was written.',
      );
    }
  }
}

type MatchedRange = { index: number; length: number };

type MatchStatus =
  | { status: 'matched'; index: number; length: number; strategy: string }
  | { status: 'none' }
  | { status: 'ambiguous'; strategy: string; count: number; matches: MatchedRange[] };

/**
 * Ranges a whitespace-tolerant strategy collects before it stops looking. An
 * internal memory bound, not a policy: ambiguity only needs a second match, and
 * exact `replace_all` never collects ranges at all.
 */
const MAX_EDIT_MATCHES = 10_000;

/** Pieces buffered before they are flattened into one bounded output chunk. */
const REPLACE_ALL_FLUSH_PIECES = 1_024;
const REPLACE_ALL_FLUSH_CHARS = 16 * 1024;

/**
 * `content.split(needle).join(replacement)` without one array entry per match: pieces are
 * flattened into chunks of bounded size, so memory tracks the output, not the match count.
 */
function replaceAllExact(
  content: string,
  needle: string,
  replacement: string,
  budget: EditWorkBudget,
): string {
  const chunks: string[] = [];
  let pieces: string[] = [];
  let pendingChars = 0;
  const flush = () => {
    chunks.push(pieces.join(''));
    pieces = [];
    pendingChars = 0;
  };
  let cursor = 0;
  for (let index = content.indexOf(needle); index !== -1; index = content.indexOf(needle, cursor)) {
    budget.occurrence();
    pieces.push(content.slice(cursor, index), replacement);
    pendingChars += index - cursor + replacement.length;
    cursor = index + needle.length;
    if (pieces.length >= REPLACE_ALL_FLUSH_PIECES || pendingChars >= REPLACE_ALL_FLUSH_CHARS) {
      flush();
    }
  }
  pieces.push(content.slice(cursor));
  flush();
  return chunks.join('');
}

/** Non-overlapping exact occurrences, counted without retaining their positions. */
function countExactMatches(content: string, needle: string, budget: EditWorkBudget): number {
  let count = 0;
  for (
    let index = content.indexOf(needle);
    index !== -1;
    index = content.indexOf(needle, index + needle.length)
  ) {
    budget.occurrence();
    count++;
  }
  return count;
}

function countExactOccurrences(content: string, needle: string, budget: EditWorkBudget): number[] {
  const indexes: number[] = [];
  let start = 0;
  while (start <= content.length && indexes.length <= MAX_EDIT_MATCHES) {
    const index = content.indexOf(needle, start);
    if (index === -1) {
      break;
    }
    budget.occurrence();
    indexes.push(index);
    start = index + Math.max(1, needle.length);
  }
  return indexes;
}

function findExactMatch(content: string, needle: string, budget: EditWorkBudget): MatchStatus {
  const matches = countExactOccurrences(content, needle, budget);
  if (matches.length === 1) {
    return { status: 'matched', index: matches[0], length: needle.length, strategy: 'exact' };
  }
  if (matches.length > 1) {
    return {
      status: 'ambiguous',
      strategy: 'exact',
      count: matches.length,
      matches: matches.map((index) => ({ index, length: needle.length })),
    };
  }
  return { status: 'none' };
}

function lineStarts(content: string): number[] {
  const starts = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') {
      starts.push(i + 1);
    }
  }
  return starts;
}

function commonIndent(lines: string[]): number {
  const indents = lines
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const match = /^(\s*)/.exec(line);
      return match ? match[1].length : 0;
    });
  return indents.length > 0 ? Math.min(...indents) : 0;
}

function stripCommonIndent(text: string): string {
  const lines = text.split('\n');
  const indent = commonIndent(lines);
  if (indent === 0) {
    return text;
  }
  return lines.map((line) => line.slice(Math.min(indent, line.length))).join('\n');
}

function findLineWindowMatch(
  content: string,
  needle: string,
  strategy: 'line-trimmed' | 'indentation-flexible',
  budget: EditWorkBudget,
): MatchStatus {
  const contentLines = content.split('\n');
  const needleLines = needle.split('\n');
  if (needleLines.length > contentLines.length) {
    return { status: 'none' };
  }

  const starts = lineStarts(content);
  const matches: Array<{ index: number; length: number }> = [];
  const addMatch = (startLine: number) => {
    const index = starts[startLine];
    const endLine = startLine + needleLines.length;
    const end = endLine < starts.length ? starts[endLine] - 1 : content.length;
    budget.occurrence();
    matches.push({ index, length: end - index });
  };

  if (strategy === 'line-trimmed') {
    // Intern normalized lines so KMP compares integer IDs, not overlapping strings.
    const ids = new Map<string, number>();
    const pattern = needleLines.map((line) => {
      const normalized = line.trimEnd();
      let id = ids.get(normalized);
      if (id == null) {
        id = ids.size;
        ids.set(normalized, id);
      }
      return id;
    });
    const prefixes = new Uint32Array(pattern.length);
    let matched = 0;
    for (let i = 1; i < pattern.length; i++) {
      while (matched > 0 && pattern[i] !== pattern[matched]) {
        matched = prefixes[matched - 1];
      }
      if (pattern[i] === pattern[matched]) matched++;
      prefixes[i] = matched;
    }

    matched = 0;
    for (let i = 0; i < contentLines.length && matches.length <= MAX_EDIT_MATCHES; i++) {
      const id = ids.get(contentLines[i].trimEnd());
      while (matched > 0 && id !== pattern[matched]) {
        matched = prefixes[matched - 1];
      }
      if (id === pattern[matched]) matched++;
      if (matched === pattern.length) {
        addMatch(i - pattern.length + 1);
        // Keep overlapping occurrences for ambiguity detection and replace_all.
        matched = prefixes[matched - 1];
      }
    }
  } else {
    // This fallback runs only after line-trimmed and whitespace-normalized miss.
    // Two nonblank needle lines imply at least two tokens: any indentation match
    // would already have matched whitespace-normalized. An all-blank needle would
    // already have matched line-trimmed. Only a single nonblank line remains.
    let anchor = -1;
    for (let i = 0; i < needleLines.length; i++) {
      if (needleLines[i].trim().length === 0) continue;
      if (anchor !== -1) return { status: 'none' };
      anchor = i;
    }
    if (anchor === -1) return { status: 'none' };

    const normalizedNeedle = stripCommonIndent(needle).split('\n');
    const nonblank = new Uint32Array(contentLines.length + 1);
    for (let i = 0; i < contentLines.length; i++) {
      nonblank[i + 1] = nonblank[i] + Number(contentLines[i].trim().length > 0);
    }
    for (let i = anchor; i < contentLines.length && matches.length <= MAX_EDIT_MATCHES; i++) {
      if (nonblank[i + 1] === nonblank[i]) continue;
      const start = i - anchor;
      const end = start + needleLines.length;
      if (end > contentLines.length) break;
      if (nonblank[end] - nonblank[start] !== 1) continue;
      const indent = contentLines[i].length - contentLines[i].trimStart().length;
      let matchesNeedle = true;
      // Eligible windows have one nonblank line at a fixed offset. Each file line
      // can belong to at most two of them, so these comparisons stay linear too.
      for (let j = 0; j < needleLines.length; j++) {
        if (contentLines[start + j].slice(indent) !== normalizedNeedle[j]) {
          matchesNeedle = false;
          break;
        }
      }
      if (matchesNeedle) addMatch(start);
    }
  }

  if (matches.length === 1) {
    return { status: 'matched', ...matches[0], strategy };
  }
  if (matches.length > 1) {
    return { status: 'ambiguous', strategy, count: matches.length, matches };
  }
  return { status: 'none' };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findWhitespaceNormalizedMatch(
  content: string,
  needle: string,
  budget: EditWorkBudget,
): MatchStatus {
  const tokens = needle.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) {
    return { status: 'none' };
  }
  const pattern = tokens.map(escapeRegExp).join('\\s+');
  const regex = new RegExp(pattern, 'g');
  const matches: Array<{ index: number; length: number }> = [];
  let match: RegExpExecArray | null;
  while (matches.length <= MAX_EDIT_MATCHES && (match = regex.exec(content)) != null) {
    budget.occurrence();
    matches.push({ index: match.index, length: match[0].length });
    if (match[0].length === 0) {
      regex.lastIndex += 1;
    }
  }
  if (matches.length === 1) {
    return { status: 'matched', ...matches[0], strategy: 'whitespace-normalized' };
  }
  if (matches.length > 1) {
    return {
      status: 'ambiguous',
      strategy: 'whitespace-normalized',
      count: matches.length,
      matches,
    };
  }
  return { status: 'none' };
}

function findReplacementMatch(
  content: string,
  needle: string,
  budget: EditWorkBudget,
  contentBytes: number,
  needleBytes: number,
): MatchStatus {
  const scanBytes = contentBytes + needleBytes;
  budget.scan(scanBytes);
  const exact = findExactMatch(content, needle, budget);
  if (exact.status !== 'none') {
    return exact;
  }
  budget.scan(scanBytes);
  const lineTrimmed = findLineWindowMatch(content, needle, 'line-trimmed', budget);
  if (lineTrimmed.status !== 'none') {
    return lineTrimmed;
  }
  budget.scan(scanBytes);
  const whitespaceNormalized = findWhitespaceNormalizedMatch(content, needle, budget);
  if (whitespaceNormalized.status !== 'none') {
    return whitespaceNormalized;
  }
  budget.scan(scanBytes);
  return findLineWindowMatch(content, needle, 'indentation-flexible', budget);
}

/** Keeps the earliest of any overlapping matches so replacements never collide. */
function nonOverlapping(matches: readonly MatchedRange[]): MatchedRange[] {
  const kept: MatchedRange[] = [];
  let end = -1;
  for (const match of [...matches].sort((a, b) => a.index - b.index)) {
    if (match.index < end) continue;
    kept.push(match);
    end = match.index + match.length;
  }
  return kept;
}

function describeMatchCount(count: number): string {
  return count > MAX_EDIT_MATCHES ? `more than ${MAX_EDIT_MATCHES}` : String(count);
}

/**
 * The size `replace_all` would produce, computed before any replacement text is
 * built so an oversized result is refused without allocating it.
 */
function projectedReplaceAllBytes(
  content: string,
  matches: readonly MatchedRange[],
  contentBytes: number,
  replacementBytes: number,
): number {
  let bytes = contentBytes;
  for (const match of matches) {
    bytes +=
      replacementBytes -
      Buffer.byteLength(content.slice(match.index, match.index + match.length), 'utf8');
  }
  return bytes;
}

function replaceMatches(content: string, matches: readonly MatchedRange[], text: string): string {
  let result = '';
  let cursor = 0;
  for (const match of matches) {
    result += content.slice(cursor, match.index) + text;
    cursor = match.index + match.length;
  }
  return result + content.slice(cursor);
}

export function applyTextEdits(
  content: string,
  edits: TextEdit[],
  limits: HostEditWorkLimits,
): HostEditResult {
  if (edits.length > limits.maxEdits) {
    throw new HostEditError(
      `File edits are limited to ${limits.maxEdits} replacements per call. Nothing was written.`,
    );
  }
  const MAX_AUTHORING_BYTES = limits.maxOutputBytes;
  const budget = new EditWorkBudget(limits);
  if (Buffer.byteLength(content) > MAX_AUTHORING_BYTES) {
    throw new HostEditError('File exceeds the authoring size limit. Nothing was written.');
  }
  let working = content;
  const strategies: string[] = [];

  for (const edit of edits) {
    const workingBytes = Buffer.byteLength(working);
    const oldBytes = Buffer.byteLength(edit.old_text);
    const newBytes = Buffer.byteLength(edit.new_text);
    budget.scan(oldBytes + newBytes);
    if (edit.replace_all === true) budget.scan(workingBytes + oldBytes);
    const exactCount =
      edit.replace_all === true ? countExactMatches(working, edit.old_text, budget) : 0;
    if (exactCount > 0) {
      const projectedBytes = workingBytes + exactCount * (newBytes - oldBytes);
      if (projectedBytes > MAX_AUTHORING_BYTES) {
        throw new HostEditError(
          `replace_all would make the file larger than ${MAX_AUTHORING_BYTES} bytes; nothing was written.`,
        );
      }
      budget.scan(workingBytes + projectedBytes);
      working = replaceAllExact(working, edit.old_text, edit.new_text, budget);
      strategies.push(exactCount > 1 ? `exact x${exactCount}` : 'exact');
      continue;
    }
    const match = findReplacementMatch(working, edit.old_text, budget, workingBytes, oldBytes);
    if (match.status === 'none') {
      throw new HostEditError('old_text did not match the file content.');
    }
    if (match.status === 'ambiguous' && edit.replace_all !== true) {
      throw new HostEditError(
        `old_text matched ${describeMatchCount(match.count)} locations with ${match.strategy}; make it unique or set replace_all before retrying.`,
      );
    }
    if (match.status === 'ambiguous') {
      if (match.count > MAX_EDIT_MATCHES) {
        throw new HostEditError(
          `replace_all with whitespace-tolerant matching is limited to ${MAX_EDIT_MATCHES} locations, and old_text matched more; copy the exact text or narrow old_text before retrying.`,
        );
      }
      const matches = nonOverlapping(match.matches);
      const projectedBytes = projectedReplaceAllBytes(working, matches, workingBytes, newBytes);
      if (projectedBytes > MAX_AUTHORING_BYTES) {
        throw new HostEditError(
          `replace_all would make the file larger than ${MAX_AUTHORING_BYTES} bytes; nothing was written.`,
        );
      }
      budget.scan(workingBytes + projectedBytes);
      working = replaceMatches(working, matches, edit.new_text);
      strategies.push(`${match.strategy} x${matches.length}`);
      continue;
    }
    const projectedBytes =
      workingBytes -
      (match.strategy === 'exact'
        ? oldBytes
        : Buffer.byteLength(working.slice(match.index, match.index + match.length))) +
      newBytes;
    if (projectedBytes > MAX_AUTHORING_BYTES) {
      throw new HostEditError(
        `edited content exceeds ${MAX_AUTHORING_BYTES} byte limit; nothing was written.`,
      );
    }
    budget.scan(workingBytes + projectedBytes);
    working =
      working.slice(0, match.index) + edit.new_text + working.slice(match.index + match.length);
    strategies.push(match.strategy);
  }

  return { content: working, strategies };
}
