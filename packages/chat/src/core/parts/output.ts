import { hasToolCallErrorPrefix, stripToolCallErrorPrefix } from 'librechat-data-provider';

/** The feedback a call gets when its input fails schema validation: the SDK
 *  returns it to the model as a plain `Error:` block closed by this sentence,
 *  with the run step still `completed`. Mirrors the server's own verdict in
 *  `completedToolExecutionStatus`, so a card, a group header and a phase
 *  agree with the label the server wrote for the same call. */
const VALIDATION_FEEDBACK = /^Error:[\s\S]*\n Please fix your mistakes\.$/i;

export function isError(text: string): boolean {
  return (
    hasToolCallErrorPrefix(text) ||
    text.startsWith('Error processing tool') ||
    VALIDATION_FEEDBACK.test(text)
  );
}

interface ContentBlock {
  type?: string;
  text?: string;
}

const ERROR_INNER = /^Error\s+\w+ing to endpoint\s*\(HTTP \d+\):\s*/i;
const PROCESSING_PREFIX = /^Error processing tool:?\s*/i;
/** Whatever prefix survives the two above, so a peek row does not spend its
 *  one line on the word the red glyph beside it already says. */
const GENERIC_ERROR_PREFIX = /^Error:\s*/i;

function cleanError(text: string): string {
  let cleaned = stripToolCallErrorPrefix(text).trim();
  cleaned = cleaned.replace(ERROR_INNER, '').trim();
  if (cleaned.endsWith('Please fix your mistakes.')) {
    cleaned = cleaned.slice(0, -'Please fix your mistakes.'.length).trim();
  }
  return cleaned;
}

export function isStructuredText(text: string): boolean {
  return text.includes('\n') || text.includes('{') || text.includes(':');
}

export interface ExtractedText {
  text: string;
  rawError: string;
  error: boolean;
  /** When true, `text` contains raw JSON that should be rendered as a highlighted code block. */
  isJson: boolean;
}

/** The text, error flag and JSON flag the default output renderer draws. */
export function extractText(raw: string, verbatim = false): ExtractedText {
  /** Command output keeps its exact bytes, whitespace-only output included:
   *  indentation and blank lines are part of it. */
  if (verbatim) {
    return { text: raw, rawError: '', error: isError(raw.trim()), isJson: false };
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return { text: '', rawError: '', error: false, isJson: false };
  }

  if (isError(trimmed)) {
    return { text: cleanError(trimmed), rawError: trimmed, error: true, isJson: false };
  }

  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);

      if (Array.isArray(parsed)) {
        const textBlocks = parsed.filter(
          (block: ContentBlock) =>
            typeof block === 'object' && block !== null && typeof block.text === 'string',
        );
        if (textBlocks.length > 0) {
          const joined = (textBlocks as ContentBlock[])
            .map((block) => block.text)
            .join('\n')
            .trim();
          if (isError(joined)) {
            return { text: cleanError(joined), rawError: joined, error: true, isJson: false };
          }
          return { text: joined, rawError: '', error: false, isJson: false };
        }
      }

      return {
        text: JSON.stringify(parsed, null, 2),
        rawError: '',
        error: false,
        isJson: true,
      };
    } catch {
      /* Not JSON. */
    }
  }

  return { text: trimmed, rawError: '', error: false, isJson: false };
}

/** Whether the default renderer would draw anything for this output. Callers
 *  that decide a panel is worth showing use it, so the two cannot disagree. */
export function hasRenderableOutput(raw?: string | null): boolean {
  return extractText(raw ?? '').text.length > 0;
}

/** The opening line of an error, for a peek row that has one line to spend. */
export function firstErrorLine(output: string | null | undefined): string {
  /** Only output that IS an error. A step the run closed as failed, or a
   *  task failed by its status attachment, can carry ordinary output, and
   *  showing that in red as the reason would misreport the failure. */
  if (!output || !isError(output)) {
    return '';
  }
  const cleaned = stripToolCallErrorPrefix(output)
    .replace(PROCESSING_PREFIX, '')
    .replace(GENERIC_ERROR_PREFIX, '')
    .trim();
  const newline = cleaned.indexOf('\n');
  return newline === -1 ? cleaned : cleaned.slice(0, newline).trim();
}
