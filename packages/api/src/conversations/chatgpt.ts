import { Constants, ContentTypes } from 'librechat-data-provider';
import type { Agents } from 'librechat-data-provider';

export interface ChatGptThought {
  content?: string | null;
  summary?: string | null;
}

export interface ChatGptExportContent {
  content_type?: string | null;
  thoughts?: ChatGptThought[] | null;
}

export interface ChatGptExportMessage {
  author?: { role?: string | null } | null;
  content?: ChatGptExportContent | null;
}

export interface ChatGptMappingNode {
  message?: ChatGptExportMessage | null;
  parent?: string | null;
}

export type ChatGptMapping = Readonly<Record<string, ChatGptMappingNode | undefined>>;

export interface ChatGptCitationMetadata {
  type?: string;
  title?: string;
  url?: string;
}

export interface ChatGptCitation {
  start_ix?: number;
  end_ix?: number;
  metadata?: ChatGptCitationMetadata | null;
}

type LinkableCitation = ChatGptCitation & {
  start_ix: number;
  end_ix: number;
  metadata: ChatGptCitationMetadata;
};

export interface ChatGptLineage {
  /** Nearest imported ancestor, passing over system, reasoning-recap and thoughts nodes. */
  findValidParent: (startId: string | null | undefined) => string;
  /** Reasoning from the thoughts node behind a response, reached through any reasoning recaps. */
  findThinkingContent: (parentId: string | null | undefined) => Agents.ReasoningContentText[];
}

const THOUGHTS = 'thoughts';
const REASONING_RECAP = 'reasoning_recap';

function isPassedOver(message: ChatGptExportMessage): boolean {
  const contentType = message.content?.content_type;
  return (
    message.author?.role === 'system' || contentType === REASONING_RECAP || contentType === THOUGHTS
  );
}

function joinThoughts(thoughts: ChatGptThought[] | null | undefined): string {
  if (!Array.isArray(thoughts)) {
    return '';
  }
  return thoughts
    .map((thought) => thought?.content || thought?.summary || '')
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Resolves parent and reasoning ancestry for one exported ChatGPT conversation.
 * Every node's answer is memoized when its walk finishes, so a long run of passed-over
 * ancestors is traversed once for the whole conversation rather than once per descendant.
 * `messageIds` maps export node ids to imported message ids and must not change afterward.
 */
export function createChatGptLineage(
  mapping: ChatGptMapping,
  messageIds: ReadonlyMap<string, string>,
): ChatGptLineage {
  const validParents = new Map<string, string>();
  const thinkingTexts = new Map<string, string>();

  const findValidParent = (startId: string | null | undefined): string => {
    const walked = new Set<string>();
    let resolved: string = Constants.NO_PARENT;
    let nodeId = startId;
    while (nodeId) {
      const known = validParents.get(nodeId);
      if (known !== undefined) {
        resolved = known;
        break;
      }
      const node = mapping[nodeId];
      if (!messageIds.has(nodeId) || walked.has(nodeId) || !node?.message) {
        break;
      }
      walked.add(nodeId);
      if (!isPassedOver(node.message)) {
        resolved = messageIds.get(nodeId) ?? Constants.NO_PARENT;
        break;
      }
      nodeId = node.parent;
    }
    for (const id of walked) {
      validParents.set(id, resolved);
    }
    return resolved;
  };

  const findThinkingText = (startId: string | null | undefined): string => {
    const walked = new Set<string>();
    let text = '';
    let nodeId = startId;
    while (nodeId) {
      const known = thinkingTexts.get(nodeId);
      if (known !== undefined) {
        text = known;
        break;
      }
      const node = mapping[nodeId];
      if (walked.has(nodeId) || !node?.message) {
        break;
      }
      walked.add(nodeId);
      const content = node.message.content;
      if (content?.content_type === THOUGHTS) {
        text = joinThoughts(content.thoughts);
        break;
      }
      if (content?.content_type !== REASONING_RECAP) {
        break;
      }
      nodeId = node.parent;
    }
    for (const id of walked) {
      thinkingTexts.set(id, text);
    }
    return text;
  };

  return {
    findValidParent,
    findThinkingContent: (parentId) => {
      const think = findThinkingText(parentId);
      return think ? [{ type: ContentTypes.THINK, think }] : [];
    },
  };
}

const isIndex = (value: number | undefined): value is number => Number.isInteger(value);

function isLinkableCitation(
  citation: ChatGptCitation | null | undefined,
): citation is LinkableCitation {
  if (citation?.metadata?.type !== 'webpage') {
    return false;
  }
  const { start_ix: start, end_ix: end } = citation;
  return isIndex(start) && isIndex(end) && start >= 0 && start < end;
}

/**
 * Replaces webpage citation markers with Markdown links in a single pass over the text.
 * Citations apply from the end of the text backward, with indices past the end clamped to it
 * as `String.prototype.slice` would; a citation overlapping one already applied is left out.
 */
export function linkChatGptCitations(
  text: string,
  citations: readonly (ChatGptCitation | null | undefined)[] | null | undefined,
): string {
  if (!text || !Array.isArray(citations)) {
    return text;
  }

  const linkable = citations.filter(isLinkableCitation).sort((a, b) => b.start_ix - a.start_ix);
  const pieces: string[] = [];
  let boundary = text.length;
  for (const citation of linkable) {
    const end = Math.min(citation.end_ix, text.length);
    if (end > boundary) {
      continue;
    }
    pieces.push(
      text.slice(end, boundary),
      ` ([${citation.metadata.title}](${citation.metadata.url}))`,
    );
    boundary = Math.min(citation.start_ix, text.length);
  }

  if (pieces.length === 0) {
    return text;
  }
  pieces.push(text.slice(0, boundary));
  return pieces.reverse().join('');
}
