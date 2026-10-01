import type {
  ClaudeMessage,
  ImportAttachment,
  ClaudeAttachment,
  ClaudeContentBlock,
  ConvertedContentPart,
} from '~/import/types';
import { createToolRegistry, beginToolCall, completeToolCall, orphanToolCall } from './tools';
import { createSourceIndex, buildSearchAttachment, applyCitations } from './citations';

export interface ConvertedClaudeContent {
  text: string;
  content?: ConvertedContentPart[];
  attachments?: ImportAttachment[];
  /** Attachments whose text Claude extracted and this import carried over. */
  extracted: number;
  /** Referenced files and images whose bytes the export does not contain. */
  unavailable: number;
}

interface ContentAccumulator {
  parts: ConvertedContentPart[];
  texts: string[];
  extracted: number;
  unavailable: number;
  /** Set once the message carries something the plain-text renderer cannot
   * show, which is what forces a `content` array to be emitted. */
  needsContent: boolean;
}

function thinkingOf(block: ClaudeContentBlock): string {
  if (block.thinking?.trim()) {
    return block.thinking;
  }
  const summaries = block.summaries ?? [];
  const joined = summaries
    .map((entry) => entry.summary ?? '')
    .filter((summary) => summary.length > 0)
    .join('\n\n');
  return joined;
}

/**
 * A user-supplied file whose text Claude extracted at upload time. The bytes are
 * absent from the export, so the extraction is the only recoverable form of what
 * the user actually sent; it is fenced and labelled with the original filename
 * rather than dropped.
 */
function attachmentBlock(attachment: ClaudeAttachment): string | null {
  const content = attachment.extracted_content;
  if (!content?.trim()) {
    return null;
  }
  const name = attachment.file_name ?? 'attachment';
  return `\`\`\`\n${name}\n${content}\n\`\`\``;
}

function pushText(accumulator: ContentAccumulator, text: string): void {
  if (text.length === 0) {
    return;
  }
  accumulator.parts.push({ type: 'text', text });
  accumulator.texts.push(text);
}

function convertBlock(
  block: ClaudeContentBlock,
  accumulator: ContentAccumulator,
  registry: ReturnType<typeof createToolRegistry>,
  sources: ReturnType<typeof createSourceIndex>,
): void {
  if (block.type === 'text') {
    pushText(accumulator, applyCitations(block.text ?? '', block.citations, sources));
    return;
  }

  if (block.type === 'thinking') {
    const thinking = thinkingOf(block);
    if (thinking.length > 0) {
      accumulator.parts.push({ type: 'think', think: thinking });
      accumulator.needsContent = true;
    }
    return;
  }

  if (block.type === 'tool_use') {
    accumulator.parts.push(beginToolCall(registry, block));
    accumulator.needsContent = true;
    return;
  }

  if (block.type === 'tool_result') {
    const resolved = completeToolCall(registry, block, sources);
    accumulator.unavailable += resolved.unavailable;
    if (!resolved.target) {
      accumulator.parts.push(orphanToolCall(block, resolved.output));
      accumulator.needsContent = true;
    }
  }
}

function appendAttachments(message: ClaudeMessage, accumulator: ContentAccumulator): void {
  for (const attachment of message.attachments ?? []) {
    const block = attachmentBlock(attachment);
    if (!block) {
      accumulator.unavailable += 1;
      continue;
    }
    accumulator.extracted += 1;
    pushText(accumulator, block);
  }
}

/**
 * Converts one Claude message's blocks into LibreChat text and content parts in
 * a single pass, keeping tool calls, reasoning, attachment extractions and
 * citation sources in their original order.
 *
 * The `content` array is withheld for a plain-text message: citations resolve
 * through `SearchContext`, which only the content-part renderer mounts, but a
 * message with neither reasoning, tool calls nor sources renders identically on
 * the simpler path and is left there.
 */
export function convertClaudeContent(message: ClaudeMessage): ConvertedClaudeContent {
  const accumulator: ContentAccumulator = {
    parts: [],
    texts: [],
    extracted: 0,
    unavailable: 0,
    needsContent: false,
  };
  const registry = createToolRegistry();
  const sources = createSourceIndex();

  for (const block of message.content ?? []) {
    convertBlock(block, accumulator, registry, sources);
  }

  appendAttachments(message, accumulator);
  accumulator.unavailable += message.files?.length ?? 0;

  if (accumulator.texts.length === 0 && message.text?.trim()) {
    pushText(accumulator, message.text);
  }

  const attachments = buildSearchAttachment(sources);
  const converted: ConvertedClaudeContent = {
    text: accumulator.texts.join('\n\n'),
    extracted: accumulator.extracted,
    unavailable: accumulator.unavailable,
  };

  if (attachments) {
    converted.attachments = [attachments];
  }
  if (accumulator.needsContent || attachments) {
    converted.content = accumulator.parts;
  }

  return converted;
}

/** Whether the message produced anything worth saving. A message with no text,
 * no reasoning, no tool activity and no recoverable attachment is dropped and
 * its children re-parented, rather than saved as an empty bubble. */
export function hasRenderableContent(converted: ConvertedClaudeContent): boolean {
  return converted.text.length > 0 || (converted.content?.length ?? 0) > 0;
}
