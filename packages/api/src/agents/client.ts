import { logger } from '@librechat/data-schemas';
import {
  ContentTypes,
  isAgentsEndpoint,
  DEFAULT_MAX_RETAINED_TOOL_COUNT_CHARS,
} from 'librechat-data-provider';
import {
  labelContentByAgent,
  extractImageDimensions,
  getTokenCountForMessage,
  estimateOpenAIImageTokens,
  estimateAnthropicImageTokens,
  markTokenCounterCacheCompatible,
} from '@librechat/agents';
import type { MessageContentComplex, TokenCounter } from '@librechat/agents';
import type { BaseMessage } from '@librechat/agents/langchain/messages';
import type { Agent, TMessage } from 'librechat-data-provider';
import type { ServerRequest } from '~/types';
import { getSafeErrorMetadata, mergeQuotedText, formatQuotesAsMarkdown } from '~/utils';
import { ATTACHMENT_ONLY_TEXT } from '~/files/context';
import Tokenizer from '~/utils/tokenizer';

export const omitTitleOptions: Set<string> = new Set([
  'stream',
  'thinking',
  'streaming',
  'clientOptions',
  'thinkingConfig',
  'thinkingBudget',
  'includeThoughts',
  'maxOutputTokens',
  'additionalModelRequestFields',
]);

export function payloadParser({
  req,
  endpoint,
}: {
  req: ServerRequest;
  endpoint: string;
}): Record<string, unknown> | undefined {
  if (isAgentsEndpoint(endpoint)) {
    return;
  }
  return req.body?.endpointOption?.model_parameters;
}

/**
 * Anthropic's API consistently reports ~10% more tokens than the local
 * claude tokenizer due to internal message framing and content encoding.
 * Verified empirically across content types via the count_tokens endpoint.
 */
export const CLAUDE_TOKEN_CORRECTION = 1.1;
const IMAGE_TOKEN_SAFETY_MARGIN = 1.05;
const BASE64_BYTES_PER_PDF_PAGE = 75_000;
const PDF_TOKENS_PER_PAGE_CLAUDE = 2000;
const PDF_TOKENS_PER_PAGE_OPENAI = 1500;
const URL_DOCUMENT_FALLBACK_TOKENS = 2000;

type ContentBlock = {
  type?: string;
  image_url?: string | { url?: string };
  source?: { type?: string; data?: string; media_type?: string; content?: unknown[] };
  source_type?: string;
  mime_type?: string;
  data?: string;
  text?: string;
  tool_call?: { id?: string; name?: string; args?: string; output?: string };
};

export type FormattedMessageContentPart = {
  type?: string;
  text?: string;
  [key: string]: unknown;
};

export type FormattedMessageWithContent = {
  role?: string;
  content?: string | FormattedMessageContentPart[];
};

/**
 * Substitutes stand-in text for a user turn that carries attachments but has
 * nothing the provider can see: file search and code environment files reach
 * the model out-of-band, so the content stays empty and Anthropic rejects the
 * message outright. Apply after the file-context and quote merges so a turn
 * that already gained inline content is left alone. The stored `message.text`
 * keeps its empty value, so the UI still renders the attachment on its own.
 *
 * Takes the turn's files rather than the message because the current turn does
 * not carry them yet: `BaseClient` assigns `userMessage.files` only after
 * `buildMessages` returns, so callers pass the resolved attachments instead.
 */
export function applyAttachmentOnlyText(
  formattedMessage: FormattedMessageWithContent,
  files?: TMessage['files'] | null,
): void {
  if (formattedMessage.role !== 'user' || !files?.length) {
    return;
  }

  if (formattedMessage.content !== '') {
    return;
  }

  formattedMessage.content = ATTACHMENT_ONLY_TEXT;
}

/**
 * Prepends context text to a formatted message: joined ahead of its string
 * content or first text part, or added as a leading text part when it has
 * neither. Array content is replaced, never edited in place: a formatted copy
 * shares its array with the stored row it came from, so the stored row and
 * every other reader of it stay untouched.
 */
export function prependContextText(
  formattedMessage: FormattedMessageWithContent,
  text: string | null | undefined,
  separator = '\n',
): void {
  if (!text) {
    return;
  }

  if (typeof formattedMessage.content === 'string') {
    formattedMessage.content = `${text}${separator}${formattedMessage.content}`;
    return;
  }

  if (!Array.isArray(formattedMessage.content)) {
    return;
  }

  const index = formattedMessage.content.findIndex(
    (part) => part.type === ContentTypes.TEXT && typeof part.text === 'string',
  );
  if (index < 0) {
    formattedMessage.content = [{ type: ContentTypes.TEXT, text }, ...formattedMessage.content];
    return;
  }
  const textPart = formattedMessage.content[index];
  formattedMessage.content = formattedMessage.content.map((part, position) =>
    position === index ? { ...textPart, text: `${text}${separator}${textPart.text}` } : part,
  );
}

export function prependFileContext(
  formattedMessage: FormattedMessageWithContent,
  fileContext?: string | null,
): void {
  prependContextText(formattedMessage, fileContext);
}

/**
 * Prepends quoted excerpts (the "Add to chat" selections persisted on
 * `message.quotes`) to a formatted message's content as Markdown blockquotes.
 * Applied to every user message that carries quotes — current and historical —
 * so the model durably receives the referenced context and the token count
 * stays consistent with what was persisted. The stored `message.text` is left
 * clean; the excerpts live on `message.quotes` for the UI.
 */
export function prependQuotes(
  formattedMessage: FormattedMessageWithContent,
  quotes?: string[] | null,
): void {
  if (quotes == null || quotes.length === 0) {
    return;
  }
  const block = formatQuotesAsMarkdown(quotes);
  if (block.length === 0) {
    return;
  }

  if (typeof formattedMessage.content === 'string') {
    formattedMessage.content = mergeQuotedText(formattedMessage.content, quotes);
    return;
  }

  if (!Array.isArray(formattedMessage.content)) {
    return;
  }

  const textPart = formattedMessage.content.find((part) => part.type === ContentTypes.TEXT);
  if (textPart != null && typeof textPart.text === 'string') {
    textPart.text = mergeQuotedText(textPart.text, quotes);
    return;
  }

  formattedMessage.content.unshift({ type: ContentTypes.TEXT, text: block });
}

function estimateImageDataTokens(data: string, isClaude: boolean): number {
  const dims = extractImageDimensions(data);
  if (dims == null) {
    return 1024;
  }
  const raw = isClaude
    ? estimateAnthropicImageTokens(dims.width, dims.height)
    : estimateOpenAIImageTokens(dims.width, dims.height);
  return Math.ceil(raw * IMAGE_TOKEN_SAFETY_MARGIN);
}

function estimateImageBlockTokens(block: ContentBlock, isClaude: boolean): number {
  let base64Data: string | undefined;
  if (block.type === 'image_url') {
    const url = typeof block.image_url === 'string' ? block.image_url : block.image_url?.url;
    if (typeof url === 'string' && url.startsWith('data:')) {
      base64Data = url;
    }
  } else if (block.type === 'image') {
    if (block.source?.type === 'base64' && typeof block.source.data === 'string') {
      base64Data = block.source.data;
    }
  }
  if (base64Data == null) {
    return 1024;
  }
  return estimateImageDataTokens(base64Data, isClaude);
}

function estimateDocumentBlockTokens(
  block: ContentBlock,
  isClaude: boolean,
  countTokens?: (text: string) => number,
): number {
  const pdfPerPage = isClaude ? PDF_TOKENS_PER_PAGE_CLAUDE : PDF_TOKENS_PER_PAGE_OPENAI;

  if (typeof block.source_type === 'string') {
    if (block.source_type === 'text' && typeof block.text === 'string') {
      return countTokens != null ? countTokens(block.text) : Math.ceil(block.text.length / 4);
    }
    if (block.source_type === 'base64' && typeof block.data === 'string') {
      const mime = (block.mime_type ?? '').split(';')[0];
      if (mime === 'application/pdf' || mime === '') {
        return Math.max(1, Math.ceil(block.data.length / BASE64_BYTES_PER_PDF_PAGE)) * pdfPerPage;
      }
      if (mime.startsWith('image/')) {
        return estimateImageDataTokens(block.data, isClaude);
      }
      return countTokens != null ? countTokens(block.data) : Math.ceil(block.data.length / 4);
    }
    return URL_DOCUMENT_FALLBACK_TOKENS;
  }

  if (block.source != null) {
    if (block.source.type === 'text' && typeof block.source.data === 'string') {
      return countTokens != null
        ? countTokens(block.source.data)
        : Math.ceil(block.source.data.length / 4);
    }
    if (block.source.type === 'base64' && typeof block.source.data === 'string') {
      const mime = (block.source.media_type ?? '').split(';')[0];
      if (mime === 'application/pdf' || mime === '') {
        const pages = Math.max(1, Math.ceil(block.source.data.length / BASE64_BYTES_PER_PDF_PAGE));
        return pages * pdfPerPage;
      }
      if (mime.startsWith('image/')) {
        return estimateImageDataTokens(block.source.data, isClaude);
      }
      return countTokens != null
        ? countTokens(block.source.data)
        : Math.ceil(block.source.data.length / 4);
    }
    if (block.source.type === 'url') {
      return URL_DOCUMENT_FALLBACK_TOKENS;
    }
    if (block.source.type === 'content' && Array.isArray(block.source.content)) {
      let tokens = 0;
      for (const inner of block.source.content) {
        const innerBlock = inner as ContentBlock | null;
        if (
          innerBlock?.type === 'image' &&
          innerBlock.source?.type === 'base64' &&
          typeof innerBlock.source.data === 'string'
        ) {
          tokens += estimateImageDataTokens(innerBlock.source.data, isClaude);
        }
      }
      return tokens;
    }
  }

  return URL_DOCUMENT_FALLBACK_TOKENS;
}

/**
 * Estimates token cost for image and document blocks in a message's
 * content array. Covers: image_url, image, image_file, document, file.
 */
export function estimateMediaTokensForMessage(
  content: unknown,
  isClaude: boolean,
  getTokenCount?: (text: string) => number,
): number {
  if (!Array.isArray(content)) {
    return 0;
  }
  let tokens = 0;
  for (const block of content as ContentBlock[]) {
    if (block == null || typeof block !== 'object' || typeof block.type !== 'string') {
      continue;
    }
    const type = block.type;
    if (type === 'image_url' || type === 'image' || type === 'image_file') {
      tokens += estimateImageBlockTokens(block, isClaude);
      continue;
    }
    if (type === 'document' || type === 'file') {
      tokens += estimateDocumentBlockTokens(block, isClaude, getTokenCount);
    }
  }
  return tokens;
}

/**
 * Single-pass token counter for formatted messages (plain objects with role/content/name).
 * Handles text, tool_call, image, and document content types in one iteration,
 * then applies Claude correction when applicable.
 */
export function countFormattedMessageTokens(
  message: Partial<Record<string, unknown>>,
  encoding: Parameters<typeof Tokenizer.getTokenCount>[1],
): number {
  const countTokens = (text: string) => Tokenizer.getTokenCount(text, encoding);
  const isClaude = encoding === 'claude';

  let numTokens = 3;

  const processValue = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item == null || typeof item !== 'object') {
          continue;
        }
        const block = item as ContentBlock;
        const type = block.type;
        if (typeof type !== 'string') {
          continue;
        }

        if (
          type === ContentTypes.THINK ||
          type === ContentTypes.ERROR ||
          // UI-only progress headers — never model input, never billed output
          type === ContentTypes.ACTIVITY_LABEL
        ) {
          continue;
        }

        if (
          type === ContentTypes.IMAGE_URL ||
          type === 'image' ||
          type === ContentTypes.IMAGE_FILE
        ) {
          numTokens += estimateImageBlockTokens(block, isClaude);
          continue;
        }

        if (type === 'document' || type === 'file') {
          numTokens += estimateDocumentBlockTokens(block, isClaude, countTokens);
          continue;
        }

        if (type === ContentTypes.TOOL_CALL && block.tool_call != null) {
          const { name, args, output } = block.tool_call;
          if (typeof name === 'string' && name) {
            numTokens += countTokens(name);
          }
          if (typeof args === 'string' && args) {
            numTokens += countTokens(args);
          }
          if (typeof output === 'string' && output) {
            numTokens += countTokens(output);
          }
          continue;
        }

        const nestedValue = (item as Record<string, unknown>)[type];
        if (nestedValue != null) {
          processValue(nestedValue);
        }
      }
      return;
    }

    if (typeof value === 'string') {
      numTokens += countTokens(value);
    } else if (typeof value === 'number') {
      numTokens += countTokens(value.toString());
    } else if (typeof value === 'boolean') {
      numTokens += countTokens(value.toString());
    }
  };

  for (const [key, value] of Object.entries(message)) {
    processValue(value);
    if (key === 'name') {
      numTokens += 1;
    }
  }

  return isClaude ? Math.ceil(numTokens * CLAUDE_TOKEN_CORRECTION) : numTokens;
}

/**
 * Exact token count of the tool results a turn retains beyond its last context
 * snapshot.
 *
 * Snapshots are dispatched pre-invoke, so the results of the tools the call they
 * precede requested are never in them; normally the next call's snapshot carries
 * those results as kept-message context, but a run that stops at the tool-call
 * limit makes no next call — the result stays on the response and in no snapshot.
 * `priorToolCallIds` are the calls the last snapshot already saw, so a call whose
 * id is absent from it belongs to that final, unsnapshotted step. The boundary is
 * the call id rather than a content index because completion reshapes the array —
 * skill cards are unshifted onto the front and `hide_sequential_outputs` replaces
 * it with a filtered one — so any index recorded mid-run means something else by
 * the time the turn is saved. A call with no id cannot be placed and is skipped.
 *
 * Only the tool OUTPUT counts. A call's name and arguments are model output,
 * already carried by the snapshot's `completedOutputTokens`, so counting them
 * again would double them. The result-message framing the next turn adds (role,
 * tool_call_id, per-message overhead) is left out as well: the figure is added to
 * exact provider accounting, so it errs low rather than overstating the context.
 * Non-string outputs are skipped, matching {@link countFormattedMessageTokens}.
 *
 * `maxCountChars` bounds the tokenization this turn may cost — one call can request
 * several tools, so the budget spans all their results — and `countExact` returns
 * `undefined` for content it cannot count exactly. Either limit withdraws the whole
 * figure: a turn whose gauge is missing the retained result is better than one
 * whose exact figures absorbed a guess. The Claude framing correction is applied,
 * matching the counter that produced the snapshot.
 */
export function countRetainedToolTokens({
  contentParts,
  priorToolCallIds,
  countExact,
  maxCountChars = DEFAULT_MAX_RETAINED_TOOL_COUNT_CHARS,
  isClaude = false,
}: {
  contentParts: ReadonlyArray<unknown> | null | undefined;
  priorToolCallIds: ReadonlySet<string> | null | undefined;
  countExact: (text: string) => number | undefined;
  maxCountChars?: number;
  isClaude?: boolean;
}): number | undefined {
  if (!Array.isArray(contentParts)) {
    return 0;
  }
  let tokens = 0;
  let charactersCounted = 0;
  for (const candidate of contentParts) {
    const part = candidate as ContentBlock | null | undefined;
    if (part == null || part.type !== ContentTypes.TOOL_CALL) {
      continue;
    }
    const { id, output } = part.tool_call ?? {};
    if (typeof id !== 'string' || id.length === 0 || priorToolCallIds?.has(id) === true) {
      continue;
    }
    if (typeof output !== 'string' || output.length === 0) {
      continue;
    }
    charactersCounted += output.length;
    if (charactersCounted > maxCountChars) {
      return undefined;
    }
    const counted = countExact(output);
    if (counted == null) {
      return undefined;
    }
    tokens += counted;
  }
  return isClaude ? Math.ceil(tokens * CLAUDE_TOKEN_CORRECTION) : tokens;
}

/** The tool calls a content array carries, by provider id — the boundary a later
 *  save path measures "retained past this snapshot" against. */
export function collectToolCallIds(
  contentParts: ReadonlyArray<unknown> | null | undefined,
): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(contentParts)) {
    return ids;
  }
  for (const candidate of contentParts) {
    const part = candidate as ContentBlock | null | undefined;
    const id = part?.type === ContentTypes.TOOL_CALL ? part.tool_call?.id : undefined;
    if (typeof id === 'string' && id.length > 0) {
      ids.add(id);
    }
  }
  return ids;
}

export function createTokenCounter(
  encoding: Parameters<typeof Tokenizer.getTokenCount>[1],
): TokenCounter {
  return createMessageTokenCounter(encoding, (text: string) =>
    Tokenizer.getTokenCount(text, encoding),
  );
}

function createMessageTokenCounter(
  encoding: Parameters<typeof Tokenizer.getTokenCount>[1],
  countTokens: (text: string) => number,
): TokenCounter {
  const isClaude = encoding === 'claude';
  return function (message: BaseMessage): number {
    const count = getTokenCountForMessage(
      message,
      countTokens,
      encoding as 'claude' | 'o200k_base',
    );
    return isClaude ? Math.ceil(count * CLAUDE_TOKEN_CORRECTION) : count;
  };
}

export async function createCachedTokenCounter(
  encoding: Parameters<typeof Tokenizer.getTokenCount>[1],
): Promise<TokenCounter> {
  const countTokens = await Tokenizer.createExactTokenCounter(encoding ?? 'o200k_base');
  return markTokenCounterCacheCompatible(createMessageTokenCounter(encoding, countTokens));
}

export function logToolError(_graph: unknown, error: unknown, toolId: string): void {
  /**
   * A GraphInterrupt unwinding out of a tool body is the HITL pause working as
   * designed (e.g. `ask_user_question` raising LangGraph `interrupt()`), not a
   * tool failure — logging it as a Tool Error at error level is alarming noise.
   * Name-based check: the class arrives from `@langchain/langgraph` inside
   * `@librechat/agents`, so an instanceof against our own import can miss.
   */
  if ((error as Error | undefined)?.name === 'GraphInterrupt') {
    return;
  }
  logger.error(
    `[api/server/controllers/agents/client.js #chatCompletion] Tool Error "${toolId}"`,
    getSafeErrorMetadata(error),
  );
}

const AGENT_SUFFIX_PATTERN = /____(\d+)$/;

/** Finds the primary agent ID within a set of agent IDs (no suffix or lowest suffix number) */
export function findPrimaryAgentId(agentIds: Set<string>): string | null {
  let primaryAgentId: string | null = null;
  let lowestSuffixIndex = Infinity;

  for (const agentId of agentIds) {
    const suffixMatch = agentId.match(AGENT_SUFFIX_PATTERN);
    if (!suffixMatch) {
      return agentId;
    }
    const suffixIndex = parseInt(suffixMatch[1], 10);
    if (suffixIndex < lowestSuffixIndex) {
      lowestSuffixIndex = suffixIndex;
      primaryAgentId = agentId;
    }
  }

  return primaryAgentId;
}

type ContentPart = TMessage['content'] extends (infer U)[] | undefined ? U : never;

/**
 * Creates a mapMethod for getMessagesForConversation that processes agent content.
 * - Strips agentId/groupId metadata from all content
 * - For parallel agents (addedConvo with groupId): filters each group to its primary agent
 * - For handoffs (agentId without groupId): keeps all content from all agents
 * - For multi-agent: applies agent labels to content
 *
 * The key distinction:
 * - Parallel execution (addedConvo): Parts have both agentId AND groupId
 * - Handoffs: Parts only have agentId, no groupId
 */
export function createMultiAgentMapper(primaryAgent: Agent, agentConfigs?: Map<string, Agent>) {
  const hasMultipleAgents = (primaryAgent.edges?.length ?? 0) > 0 || (agentConfigs?.size ?? 0) > 0;

  let agentNames: Record<string, string> | null = null;
  if (hasMultipleAgents) {
    agentNames = { [primaryAgent.id]: primaryAgent.name || 'Assistant' };
    if (agentConfigs) {
      for (const [agentId, agentConfig] of agentConfigs.entries()) {
        agentNames[agentId] = agentConfig.name || agentConfig.id;
      }
    }
  }

  return (message: TMessage): TMessage => {
    if (message.isCreatedByUser || !Array.isArray(message.content)) {
      return message;
    }

    const hasAgentMetadata = message.content.some(
      (part) =>
        (part as ContentPart & { agentId?: string; groupId?: number })?.agentId ||
        (part as ContentPart & { groupId?: number })?.groupId != null,
    );
    if (!hasAgentMetadata) {
      return message;
    }

    try {
      const groupAgentMap = new Map<number, Set<string>>();

      for (const part of message.content) {
        const p = part as ContentPart & { agentId?: string; groupId?: number };
        const groupId = p?.groupId;
        const agentId = p?.agentId;
        if (groupId != null && agentId) {
          if (!groupAgentMap.has(groupId)) {
            groupAgentMap.set(groupId, new Set());
          }
          groupAgentMap.get(groupId)!.add(agentId);
        }
      }

      const groupPrimaryMap = new Map<number, string>();
      for (const [groupId, agentIds] of groupAgentMap) {
        const primary = findPrimaryAgentId(agentIds);
        if (primary) {
          groupPrimaryMap.set(groupId, primary);
        }
      }

      const filteredContent: ContentPart[] = [];
      const agentIdMap: Record<number, string> = {};

      for (const part of message.content) {
        const p = part as ContentPart & { agentId?: string; groupId?: number };
        const agentId = p?.agentId;
        const groupId = p?.groupId;

        const isParallelPart = groupId != null;
        const groupPrimary = isParallelPart ? groupPrimaryMap.get(groupId) : null;
        const shouldInclude = !isParallelPart || !agentId || agentId === groupPrimary;

        if (shouldInclude) {
          const newIndex = filteredContent.length;
          const { agentId: _a, groupId: _g, ...cleanPart } = p;
          filteredContent.push(cleanPart as ContentPart);
          if (agentId && hasMultipleAgents) {
            agentIdMap[newIndex] = agentId;
          }
        }
      }

      const finalContent =
        Object.keys(agentIdMap).length > 0 && agentNames
          ? labelContentByAgent(filteredContent as MessageContentComplex[], agentIdMap, agentNames)
          : filteredContent;

      return { ...message, content: finalContent as TMessage['content'] };
    } catch (error) {
      logger.error(
        '[AgentClient] Error processing multi-agent message:',
        getSafeErrorMetadata(error),
      );
      return message;
    }
  };
}
