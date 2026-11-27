/** Max characters kept per quoted excerpt (defense-in-depth over the client cap). */
export const QUOTE_MAX_LENGTH = 1500;

/** Max number of quoted excerpts merged into a single user turn. */
export const QUOTE_MAX_COUNT = 10;

export interface ReferencedQuoteEntry {
  readonly sourceIndex: number;
  readonly text: string;
}

function toQuoteText(text: string): string {
  return text;
}

function toQuoteEntry(text: string, sourceIndex: number): ReferencedQuoteEntry {
  return { sourceIndex, text };
}

function normalizeReferencedQuotes<T>(
  raw: unknown,
  createValue: (text: string, sourceIndex: number) => T,
): T[] | null {
  if (!Array.isArray(raw)) {
    return null;
  }

  const quotes: T[] = [];
  for (let sourceIndex = 0; sourceIndex < raw.length; sourceIndex++) {
    const item: unknown = raw[sourceIndex];
    if (typeof item !== 'string') {
      continue;
    }
    const trimmed = item.trim();
    if (trimmed.length === 0) {
      continue;
    }
    quotes.push(createValue(trimmed.slice(0, QUOTE_MAX_LENGTH), sourceIndex));
    if (quotes.length >= QUOTE_MAX_COUNT) {
      break;
    }
  }

  return quotes.length > 0 ? quotes : null;
}

/**
 * Normalizes the `quotes` field off a request body into a clean string array.
 * Trims, drops empties/non-strings, caps each excerpt length and the overall
 * count. Returns `null` when there is nothing usable so callers can skip the
 * merge entirely.
 */
export function getReferencedQuotes(raw: unknown): string[] | null {
  return normalizeReferencedQuotes(raw, toQuoteText);
}

/** Normalizes quotes while retaining their source-array positions. */
export function getReferencedQuoteEntries(raw: unknown): ReferencedQuoteEntry[] | null {
  return normalizeReferencedQuotes(raw, toQuoteEntry);
}

/** Formats one excerpt as a Markdown blockquote, prefixing every line. */
function toBlockquote(quote: string): string {
  return quote
    .split('\n')
    .map((line) => (line.length > 0 ? `> ${line}` : '>'))
    .join('\n');
}

/**
 * Renders quoted excerpts as Markdown blockquote blocks, one block per excerpt
 * separated by a blank line. Provider-agnostic (no bespoke tags). Returns an
 * empty string when there are no quotes.
 */
export function formatQuotesAsMarkdown(quotes: string[]): string {
  return quotes.map(toBlockquote).join('\n\n');
}

/**
 * Merges quoted excerpts into a body of text as Markdown blockquotes, prepended
 * before the text so the excerpts read as part of the user turn. Returns the
 * original text unchanged when there are no quotes.
 */
export function mergeQuotedText(text: string, quotes: string[]): string {
  if (quotes.length === 0) {
    return text;
  }

  const block = formatQuotesAsMarkdown(quotes);
  if (block.length === 0) {
    return text;
  }
  const body = text ?? '';
  return body.length > 0 ? `${block}\n\n${body}` : block;
}

/**
 * Resolves the prompt text to tokenize for a (possibly quoted) user turn,
 * mirroring the send path: a user message's persisted `quotes` are prepended
 * into the prompt on every turn, so an edit that only changes `text` must count
 * the merged text+quotes to keep the stored `tokenCount` authoritative. Returns
 * `text` unchanged for non-user messages or when there are no usable quotes.
 */
export function mergeQuotedTextForCount(
  text: string,
  rawQuotes: unknown,
  isCreatedByUser: boolean,
): string {
  if (!isCreatedByUser) {
    return text;
  }
  const quotes = getReferencedQuotes(rawQuotes);
  return quotes ? mergeQuotedText(text, quotes) : text;
}
