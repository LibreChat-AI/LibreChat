import { logger } from '@librechat/data-schemas';
import { formatMessage } from '@librechat/agents';
import { ContentTypes } from 'librechat-data-provider';
import type { TFile, TurnFileConsumers } from 'librechat-data-provider';
import type { IMongoFile } from '@librechat/data-schemas';
import type { SteerQueueItem } from '~/stream/interfaces/IJobStore';
import type { SteerFileFetcher } from './request';
import type { SteerMediaResult } from './runtime';
import type { SteerRequestUser } from './refs';
import { toSteerFileRef, collectFileIds, buildOwnerFilter } from './refs';
import { isAttachmentObjectNotFoundError } from '~/files/encode/utils';
import { getReferencedQuotes, mergeQuotedText } from '~/utils';
import { prependFileContext } from '../client';

/** The BaseClient encode surface the steer media pipeline reuses. */
export interface SteerMediaClient {
  /** The turn's view of stored records, which every check and encode below must share. */
  resolveTurnAttachments(files: IMongoFile[], consumers?: TurnFileConsumers): IMongoFile[];
  addFileContextToMessage(
    message: Record<string, unknown>,
    files: IMongoFile[],
    consumers?: TurnFileConsumers,
  ): Promise<void>;
  processAttachments(
    message: Record<string, unknown>,
    files: IMongoFile[],
    consumers?: TurnFileConsumers,
  ): Promise<IMongoFile[] | undefined>;
}

interface PseudoMessage {
  messageId: string;
  fileContext?: string;
  image_urls?: Array<Record<string, unknown>>;
  documents?: Array<Record<string, unknown>>;
  videos?: Array<Record<string, unknown>>;
  audios?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

interface SteerPart {
  type?: string;
  steerId?: string;
  files?: Partial<TFile>[];
  quotes?: string[];
  media?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

/** One stamped steer part: payload index + the stamped content array, so the
 *  caller can fold the re-encoded media into its token accounting. */
export interface StampedSteerMedia {
  index: number;
  sourceMessageId?: string;
  fileIds: string[];
  media: Array<Record<string, unknown>>;
  /** The bare steer body, so token accounting can subtract what the
   *  assistant message already counted (file context must still count). */
  steerText: string;
}

/** The model-bound body for a steer: quoted excerpts prepended as Markdown
 *  blockquotes, exactly like `prependQuotes` does for regular user turns. The
 *  persisted part keeps `steer`/`quotes` separate; only this boundary merges. */
function mergeSteerModelText(text: string, quotes?: string[] | null): string {
  const normalized = getReferencedQuotes(quotes);
  return normalized != null ? mergeQuotedText(text, normalized) : text;
}

/**
 * Encodes authorized file docs for one steer and assembles the multimodal
 * content array, reusing the exact pipeline regular user turns go through:
 * `addFileContextToMessage` + `processAttachments` (single-pass categorize +
 * encode images/documents/videos/audios) on a throwaway message, then the
 * SDK's `formatMessage` for part ordering (no `endpoint` arg — matching the
 * agents payload path, which formats without one). Quoted excerpts merge into
 * the text part so the model receives them wherever the content array lands.
 */
async function encodeSteerContent({
  client,
  text,
  quotes,
  steerId,
  fileDocs,
  fileConsumers,
}: {
  client: SteerMediaClient;
  text: string;
  quotes?: string[] | null;
  steerId: string;
  fileDocs: IMongoFile[];
  fileConsumers?: TurnFileConsumers;
}): Promise<SteerMediaResult> {
  const modelText = mergeSteerModelText(text, quotes);
  const pseudo: PseudoMessage = { messageId: `steer:${steerId}` };
  await client.addFileContextToMessage(pseudo, fileDocs, fileConsumers);
  const validated = await client.processAttachments(pseudo, fileDocs, fileConsumers);
  const formatted = formatMessage({
    message: {
      role: 'user',
      content: modelText,
      image_urls: pseudo.image_urls,
      documents: pseudo.documents,
      videos: pseudo.videos,
      audios: pseudo.audios,
    } as Parameters<typeof formatMessage>[0]['message'],
  }) as { content: string | Array<Record<string, unknown>> };
  if (pseudo.fileContext) {
    prependFileContext(formatted, pseudo.fileContext);
  }
  const content = Array.isArray(formatted.content)
    ? formatted.content
    : [{ type: ContentTypes.TEXT, text: formatted.content ?? modelText }];
  const refSource = Array.isArray(validated) && validated.length > 0 ? validated : fileDocs;
  const files = refSource.map(toSteerFileRef).filter((ref): ref is Partial<TFile> => ref != null);
  return { content, files };
}

/**
 * Resolves a queued steer's attachment refs into encoded model content for
 * live mid-run injection. Only `file_id`s are trusted from the item — the
 * fetch is owner-scoped and every other field is re-derived from the DB docs,
 * restored to the composer's ref order (a `$in` result comes back in database
 * order). Returns `undefined` when nothing authorized remains (the drain hook
 * then injects text only, so the user's words always land).
 */
export async function buildSteerMedia({
  client,
  user,
  item,
  getFiles,
  assertFilesAllowed,
}: {
  client: SteerMediaClient;
  user: SteerRequestUser | undefined;
  item: SteerQueueItem;
  getFiles: SteerFileFetcher;
  assertFilesAllowed?: (files: IMongoFile[]) => void;
}): Promise<SteerMediaResult | undefined> {
  const ids = collectFileIds(item.files);
  const filter = buildOwnerFilter(ids, user);
  if (filter == null) {
    return undefined;
  }
  const rawDocs = await getFiles(filter, {}, {});
  if (!Array.isArray(rawDocs) || rawDocs.length === 0) {
    logger.warn(`[buildSteerMedia] No authorized files for steer=${item.steerId}`);
    return undefined;
  }
  const docsById = new Map(rawDocs.map((file) => [file.file_id, file]));
  /* These files arrived after resource priming. A loaded tool is not evidence that
   * it can access them; use the opted-in text fallback until a new turn provisions them. */
  const fileConsumers: TurnFileConsumers = { executeCode: false, fileSearch: false };
  const fileDocs = client.resolveTurnAttachments(
    ids.map((id) => docsById.get(id)).filter((doc): doc is IMongoFile => doc != null),
    fileConsumers,
  );
  assertFilesAllowed?.(fileDocs);
  return encodeSteerContent({
    client,
    text: item.text,
    quotes: item.quotes,
    steerId: item.steerId,
    fileDocs,
    fileConsumers,
  });
}

export interface SteerStampTarget {
  message: { id?: string; messageId?: string; content?: unknown };
  part: SteerPart;
  index: number;
  quotes: string[] | null;
  encodeFiles: boolean;
}

export type SteerStampPayload = Array<{
  id?: string;
  messageId?: string;
  role?: string;
  content?: unknown;
}>;

/** One pass over the payload for everything the stamp needs. Callers check
 *  `.length` for the zero-await fast path and hand the result to
 *  `stampSteerPartMedia`, so the history is never scanned twice. */
export function collectSteerStampTargets(
  payload: SteerStampPayload,
  resendFiles: boolean,
): SteerStampTarget[] {
  const targets: SteerStampTarget[] = [];
  for (let index = 0; index < payload.length; index++) {
    const message = payload[index];
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) {
      continue;
    }
    for (const part of message.content as SteerPart[]) {
      if (part?.type !== ContentTypes.STEER) {
        continue;
      }
      const quotes = getReferencedQuotes(part.quotes);
      const encodeFiles = resendFiles && Array.isArray(part.files) && part.files.length > 0;
      if (encodeFiles || quotes != null) {
        targets.push({ message, part, index, quotes, encodeFiles });
      }
    }
  }
  return targets;
}

/**
 * Re-encodes attachments and re-merges quotes for persisted steer parts of
 * PAST turns, stamping the assembled content array as a transient `media`
 * field, which the SDK's `formatAgentMessages` prefers over the plain text
 * when reconstructing the steer's HumanMessage. Refs are re-encoded per turn
 * — encoded data is never persisted — and parts are replaced immutably so the
 * stamp cannot leak into a message save. Encodes run in parallel after doc
 * resolution.
 *
 * Quote-bearing parts are stamped UNCONDITIONALLY (a merged text part is the
 * only way the excerpts reach the model on replay, mirroring `prependQuotes`
 * for regular user turns), while file encoding remains gated on the
 * conversation's `resendFiles` setting — a quote-bearing part whose files are
 * not resent still replays its quotes, exactly like its text.
 *
 * `docsById` should be the owner-scoped doc map `addPreviousAttachments`
 * already fetched this turn (its single historical-files query collects
 * steer-part refs); when present, NO extra query is issued — an id missing
 * from the map is unauthorized or deleted, exactly as if the fallback query
 * had excluded it.
 */
export async function stampSteerPartMedia({
  client,
  user,
  payload,
  targets,
  docsById,
  getFiles,
  resendFiles = true,
}: {
  client: SteerMediaClient;
  user: SteerRequestUser | undefined;
  payload: SteerStampPayload;
  /** Pre-collected via `collectSteerStampTargets` so the caller's zero-await
   *  probe and this stamp share one payload scan; collected here otherwise. */
  targets?: SteerStampTarget[];
  docsById?: Map<string, IMongoFile>;
  getFiles: SteerFileFetcher;
  resendFiles?: boolean;
}): Promise<StampedSteerMedia[]> {
  const stampTargets = targets ?? collectSteerStampTargets(payload, resendFiles);
  if (stampTargets.length === 0) {
    return [];
  }

  let resolvedDocsById = docsById;
  const fileTargets = stampTargets.filter(({ encodeFiles }) => encodeFiles);
  if (resolvedDocsById == null && fileTargets.length > 0) {
    const allIds = collectFileIds(fileTargets.flatMap(({ part }) => part.files ?? []));
    const filter = buildOwnerFilter(allIds, user);
    if (filter != null) {
      const fileDocs = await getFiles(filter, {}, {});
      if (Array.isArray(fileDocs) && fileDocs.length > 0) {
        resolvedDocsById = new Map(
          client.resolveTurnAttachments(fileDocs).map((file) => [file.file_id, file]),
        );
      }
    }
  }
  const docs = resolvedDocsById;

  const stamped: Array<StampedSteerMedia | null> = await Promise.all(
    stampTargets.map(
      async ({ message, part, index, quotes, encodeFiles }): Promise<StampedSteerMedia | null> => {
        const steerText = (part[ContentTypes.STEER] as string | undefined) ?? '';
        const partDocs = encodeFiles
          ? (part.files ?? [])
              .map((file) => (file?.file_id != null ? docs?.get(file.file_id) : undefined))
              .filter((doc): doc is IMongoFile => doc != null)
          : [];
        const stampPart = (content: Array<Record<string, unknown>>, fileIds: string[]) => {
          message.content = (message.content as SteerPart[]).map((candidate) =>
            candidate === part ? { ...candidate, media: content } : candidate,
          );
          return {
            index,
            sourceMessageId: message.messageId ?? message.id,
            fileIds,
            media: content,
            steerText,
          };
        };
        /** No authorized docs (or files not resent): a quote-bearing part
         *  still stamps its merged text so the excerpts replay; a files-only
         *  part falls back to plain-text replay exactly as before. */
        const stampMergedTextOnly = () => {
          if (quotes == null) {
            return null;
          }
          return stampPart(
            [{ type: ContentTypes.TEXT, text: mergeSteerModelText(steerText, quotes) }],
            [],
          );
        };
        if (partDocs.length === 0) {
          return stampMergedTextOnly();
        }
        try {
          const { content, files } = await encodeSteerContent({
            client,
            text: steerText,
            quotes,
            steerId: part.steerId ?? 'replay',
            fileDocs: partDocs,
          });
          return stampPart(
            content,
            (files ?? [])
              .map((file) => file.file_id)
              .filter(
                (fileId): fileId is string => typeof fileId === 'string' && fileId.length > 0,
              ),
          );
        } catch (error) {
          if (isAttachmentObjectNotFoundError(error)) {
            throw error;
          }
          logger.warn(
            `[stampSteerPartMedia] Failed to re-encode steer media (steer=${part.steerId}); replaying text only`,
            error,
          );
          return stampMergedTextOnly();
        }
      },
    ),
  );
  return stamped.filter((entry): entry is StampedSteerMedia => entry != null);
}
