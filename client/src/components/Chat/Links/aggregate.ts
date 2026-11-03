import { Tools } from 'librechat-data-provider';
import type {
  ImageResult,
  ResultReference,
  SearchResultData,
  TAttachment,
  TMessage,
  ValidSource,
} from 'librechat-data-provider';

export type SessionFileSource = {
  file_id: string;
  filename: string;
  bytes?: number;
  type?: string;
  source?: string;
  pages?: number[];
  relevance?: number;
  pageRelevance?: Record<number, number>;
  metadata?: { storageType?: string } & Record<string, unknown>;
  messageId: string;
  toolCallId: string;
};

export type SessionSources = {
  links: ValidSource[];
  news: ValidSource[];
  images: ImageResult[];
  files: SessionFileSource[];
};

/** Runtime payload of a `file_search` attachment, typed defensively like `useSearchResultsByTurn`. */
type FileSearchAttachmentData = SearchResultData & {
  sources?: Array<{
    fileId: string;
    fileName: string;
    bytes?: number;
    type?: string;
    source?: string;
    pages?: number[];
    relevance?: number;
    pageRelevance?: Record<string, number>;
    metadata?: { storageType?: string } & Record<string, unknown>;
  }>;
};

/** A web-search reference carrying agent file-search fields, as `Sources.tsx` reads them. */
type FileReference = ResultReference & {
  fileId?: string;
  fileName?: string;
  pages?: number[];
  relevance?: number;
  pageRelevance?: Record<string, number>;
  metadata?: { storageType?: string } & Record<string, unknown>;
};

const isFileReference = (reference: ResultReference): reference is FileReference =>
  reference.type ===
  'file'; /** Merges a file citation into the session list, unioning cited pages across turns. */
function mergeFileSource(files: Map<string, SessionFileSource>, file: SessionFileSource): void {
  const key = `${file.file_id}\u0000${file.filename}`;
  const existing = files.get(key);
  if (existing == null) {
    files.set(key, file);
    return;
  }
  const pages = file.pages?.length
    ? [...new Set([...(existing.pages ?? []), ...file.pages])].sort((a, b) => a - b)
    : existing.pages;
  files.set(key, {
    ...existing,
    pages,
    relevance: Math.max(existing.relevance ?? 0, file.relevance ?? 0),
    pageRelevance: { ...(existing.pageRelevance ?? {}), ...(file.pageRelevance ?? {}) },
  });
}

function collectWebSearch(
  data: SearchResultData,
  attachment: TAttachment,
  links: Map<string, ValidSource>,
  news: Map<string, ValidSource>,
  images: Map<string, ImageResult>,
  files: Map<string, SessionFileSource>,
): void {
  /* First occurrence wins: the panel lists sources in the order the session
   * first used them, and a later turn citing the same page adds nothing. */
  data.organic?.forEach((source) => {
    if (source.link && !links.has(source.link)) {
      links.set(source.link, source);
    }
  });
  data.topStories?.forEach((source) => {
    if (source.link && !news.has(source.link)) {
      news.set(source.link, source);
    }
  });
  data.images?.forEach((image) => {
    if (image.imageUrl && !images.has(image.imageUrl)) {
      images.set(image.imageUrl, image);
    }
  });
  data.references?.forEach((reference) => {
    if (isFileReference(reference)) {
      const fileId = reference.fileId ?? 'unknown';
      const filename = reference.title ?? reference.fileName ?? 'Unknown File';
      mergeFileSource(files, {
        file_id: fileId,
        filename,
        metadata: reference.metadata,
        pages: reference.pages,
        relevance: reference.relevance,
        pageRelevance: reference.pageRelevance,
        messageId: attachment.messageId,
        toolCallId: attachment.toolCallId,
      });
    } else if (reference.type === 'image' && reference.link) {
      if (!images.has(reference.link)) {
        images.set(reference.link, { title: reference.title, imageUrl: reference.link });
      }
    } else if (reference.link && !links.has(reference.link)) {
      links.set(reference.link, {
        link: reference.link,
        title: reference.title,
        snippet: (reference as { snippet?: string }).snippet,
      });
    }
  });
}

function collectFileSearch(
  data: FileSearchAttachmentData,
  attachment: TAttachment,
  files: Map<string, SessionFileSource>,
): void {
  if (!Array.isArray(data.sources)) {
    return;
  }
  data.sources.forEach((source) => {
    mergeFileSource(files, {
      file_id: source.fileId,
      filename: source.fileName,
      bytes: source.bytes,
      type: source.type,
      source: source.source,
      pages: source.pages,
      relevance: source.relevance,
      pageRelevance: source.pageRelevance,
      metadata: source.metadata,
      messageId: attachment.messageId,
      toolCallId: attachment.toolCallId,
    });
  });
}

function collectAttachment(
  attachment: TAttachment,
  links: Map<string, ValidSource>,
  news: Map<string, ValidSource>,
  images: Map<string, ImageResult>,
  files: Map<string, SessionFileSource>,
): void {
  if (attachment.type === Tools.web_search) {
    const data = attachment[Tools.web_search];
    if (data != null) {
      collectWebSearch(data, attachment, links, news, images, files);
    }
    return;
  }
  if (attachment.type === Tools.file_search) {
    const data = attachment[Tools.file_search] as FileSearchAttachmentData | undefined;
    if (data != null) {
      collectFileSearch(data, attachment, files);
    }
  }
}

/**
 * Aggregates every source the conversation used — web results, news, images and
 * cited files — across all of its messages, plus any still-streaming
 * attachments the message cache has not saved yet. First occurrence wins for
 * links and images; file citations merge their cited pages.
 */
export function aggregateSessionSources(
  messages: TMessage[],
  liveAttachments?: TAttachment[],
): SessionSources {
  const links = new Map<string, ValidSource>();
  const news = new Map<string, ValidSource>();
  const images = new Map<string, ImageResult>();
  const files = new Map<string, SessionFileSource>();

  for (const message of messages) {
    message.attachments?.forEach((attachment) => {
      collectAttachment(attachment, links, news, images, files);
    });
  }
  liveAttachments?.forEach((attachment) => {
    collectAttachment(attachment, links, news, images, files);
  });

  return {
    links: Array.from(links.values()),
    news: Array.from(news.values()),
    images: Array.from(images.values()),
    files: Array.from(files.values()),
  };
}

export function hasSessionSources(sources: SessionSources): boolean {
  return countSessionSources(sources) > 0;
}

export function countSessionSources(sources: SessionSources): number {
  return sources.links.length + sources.news.length + sources.images.length + sources.files.length;
}

/**
 * Live attachments still streaming into messages the cache has not saved.
 * Keyed by message id across every conversation the store is tracking, so a
 * conversation's panel takes only its own.
 */
export function liveAttachmentsForConversation(
  attachmentsMap: Record<string, TAttachment[] | undefined>,
  conversationId: string,
): TAttachment[] {
  return Object.values(attachmentsMap)
    .flatMap((attachments) => attachments ?? [])
    .filter((attachment) => attachment.conversationId === conversationId);
}
