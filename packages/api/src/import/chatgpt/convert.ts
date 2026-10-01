import { v4 as uuidv4 } from 'uuid';
import { Tools, Constants, ContentTypes } from 'librechat-data-provider';
import type {
  ChatGptNode,
  ImageFilePart,
  ImportedAsset,
  ImportAttachment,
  ImportedCitations,
  ConvertedMessage,
  ChatGptConversation,
  ConvertedContentPart,
  ConvertedConversation,
} from '~/import/types';
import { convertContent, collectAssetPointers } from './content';
import { buildCitations } from './citations';
import { orderTree } from '~/import/tree';
import { resolveModel } from './models';

function toTimestamp(value: unknown): number | null {
  if (value == null || value === '') {
    return null;
  }
  const timestamp = Number(value) * 1000;
  return Number.isFinite(timestamp) ? timestamp : null;
}

const SKIPPED_CONTENT = new Set(['thoughts', 'reasoning_recap']);

export interface ConvertOptions {
  userId: string;
  assets: Map<string, ImportedAsset>;
  defaultModel: string;
}

function isEmitted(node: ChatGptNode): boolean {
  const message = node.message;
  if (!message?.content?.content_type) {
    return false;
  }
  if (message.author.role === 'system') {
    return false;
  }
  return !SKIPPED_CONTENT.has(message.content.content_type);
}

/**
 * Walks up `parent` links iteratively; recursion would overflow on the deep
 * chains real exports contain. `visited` breaks the cycles seen in the wild.
 */
function findParent(
  startId: string | null,
  mapping: Record<string, ChatGptNode>,
  ids: Map<string, string>,
  resolved: Map<string, string>,
): string {
  const visited = new Set<string>();
  const walked: string[] = [];
  let current = startId;
  let result = Constants.NO_PARENT as string;

  while (current && !visited.has(current)) {
    const cached = resolved.get(current);
    if (cached !== undefined) {
      result = cached;
      break;
    }
    visited.add(current);
    walked.push(current);
    const node = mapping[current];
    if (!node) {
      break;
    }
    const mapped = ids.get(current);
    if (mapped && isEmitted(node)) {
      result = mapped;
      break;
    }
    current = node.parent;
  }

  /** Every node this walk crossed resolves to the same nearest emitted
   * ancestor, so recording them all means the next sibling branch stops at the
   * first shared node instead of re-walking the chain. Exports interleave long
   * runs of skipped `system`/`thoughts`/`reasoning_recap` nodes, and a fresh
   * walk per message over those runs is what makes a deep thread quadratic
   * (the same trap `tree.ts` documents). `ids` is fully built before the
   * conversion loop, so a resolved answer never changes mid-conversation. */
  for (const nodeId of walked) {
    resolved.set(nodeId, result);
  }

  return result;
}

function findThinking(startId: string | null, mapping: Record<string, ChatGptNode>): string | null {
  const visited = new Set<string>();
  let current = startId;

  while (current && !visited.has(current)) {
    visited.add(current);
    const content = mapping[current]?.message?.content;
    if (!content) {
      return null;
    }
    if (content.content_type === 'thoughts') {
      const thoughts = content.thoughts ?? [];
      const joined = thoughts
        .map((thought) => thought.content || thought.summary || '')
        .filter((entry) => entry.length > 0)
        .join('\n\n');
      return joined.length > 0 ? joined : null;
    }
    if (content.content_type !== 'reasoning_recap') {
      return null;
    }
    current = mapping[current].parent;
  }

  return null;
}

function buildAttachments(citations: ImportedCitations[]): ImportAttachment[] | undefined {
  if (citations.length === 0) {
    return undefined;
  }
  return citations.map((citation) => ({
    type: Tools.web_search,
    [Tools.web_search]: citation.data,
  }));
}

/**
 * Assistant images render from nested `image_file` content parts
 * (`Part.tsx`), not from `message.files`; the only consumer of that field
 * is gated on `isCreatedByUser`. Non-image assets stay on `message.files`,
 * which the legacy renderer surfaces for messages that carry no content.
 */
function buildImageParts(files: ImportedAsset[]): ImageFilePart[] {
  const parts: ImageFilePart[] = [];
  for (const file of files) {
    if (file.type.startsWith('image/')) {
      parts.push({ type: ContentTypes.IMAGE_FILE, [ContentTypes.IMAGE_FILE]: file });
    }
  }
  return parts;
}

/**
 * Citations resolve through `SearchContext`, which only the content-part
 * renderer mounts: an assistant message routed to the legacy renderer
 * (`MultiMessage` dispatches on `message.content`) drops every anchor.
 * So content is emitted whenever the message carries reasoning, citation
 * attachments, or images, and withheld otherwise, leaving plain text on
 * the exact path it rendered on before.
 */
function buildContent(
  text: string,
  thinking: string | null,
  attachments: ImportAttachment[] | undefined,
  imageParts: ImageFilePart[],
): ConvertedContentPart[] | undefined {
  if (!thinking && !attachments && imageParts.length === 0) {
    return undefined;
  }

  const content: ConvertedContentPart[] = [];
  if (thinking) {
    content.push({ type: 'think', think: thinking });
  }
  content.push({ type: 'text', text });
  content.push(...imageParts);
  return content;
}

export function convertConversation(
  conv: ChatGptConversation,
  options: ConvertOptions,
): ConvertedConversation {
  const mapping = conv.mapping ?? {};
  const ids = new Map<string, string>();

  for (const [nodeId, node] of Object.entries(mapping)) {
    if (isEmitted(node)) {
      ids.set(nodeId, uuidv4());
    }
  }

  /** Shared by every `findParent` call in this conversation; see the backfill
   * there. Scoped per conversation because `mapping` and `ids` are. */
  const resolvedParents = new Map<string, string>();
  const fallbackTime = toTimestamp(conv.create_time) ?? Date.now();
  const messages: ConvertedMessage[] = [];

  for (const [nodeId, node] of Object.entries(mapping)) {
    const messageId = ids.get(nodeId);
    if (!messageId || !node.message) {
      continue;
    }

    const message = node.message;
    const isCreatedByUser = message.author.role === 'user';
    const converted0 = convertContent(message, options.assets);
    const cited = isCreatedByUser
      ? { text: converted0.text, citations: [] }
      : buildCitations(message, converted0.text);
    const text = cited.text;
    const files = converted0.files;
    const { model, sender } = resolveModel(
      message.metadata?.model_slug ?? conv.default_model_slug ?? undefined,
      options.defaultModel,
    );

    const converted: ConvertedMessage = {
      messageId,
      parentMessageId: findParent(node.parent, mapping, ids, resolvedParents),
      text,
      sender: isCreatedByUser ? 'user' : sender,
      isCreatedByUser,
      model,
      createdAt: new Date(toTimestamp(message.create_time) ?? fallbackTime),
      assetPointers: collectAssetPointers(message),
    };

    if (!isCreatedByUser) {
      const thinking = findThinking(node.parent, mapping);
      const attachments = buildAttachments(cited.citations);
      const content = buildContent(text, thinking, attachments, buildImageParts(files));
      if (attachments) {
        converted.attachments = attachments;
      }
      if (content) {
        converted.content = content;
      }
    }

    if (files.length > 0) {
      converted.files = files;
    }

    messages.push(converted);
  }

  orderTree(messages);

  return {
    conversationId: uuidv4(),
    externalId: conv.conversation_id,
    title: conv.title || 'Imported Chat',
    createdAt: new Date(fallbackTime),
    isArchived: conv.is_archived === true,
    pinned: conv.is_starred === true || conv.pinned_time != null,
    /** The conversation's model is what its *next* prompt is sent with, so it
     * has to be a model this deployment actually serves. `default_model_slug`
     * is a historical ChatGPT identifier (`auto`, `research`, `gpt-5-t`) that
     * no endpoint accepts, and setting it here would leave every imported
     * conversation unusable until the user picked a model by hand. The
     * per-message `model` keeps the historical slug for display, which is
     * where it belongs; the Claude and Grok converters resolve this field the
     * same way. */
    model: options.defaultModel,
    messages,
  };
}
