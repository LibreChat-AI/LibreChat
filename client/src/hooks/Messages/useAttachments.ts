import { useMemo } from 'react';
import { useRecoilValue } from 'recoil';
import type { TAttachment, TFile } from 'librechat-data-provider';
import { useSearchResultsByTurn } from './useSearchResultsByTurn';
import { attachmentIdentity } from '~/utils/media';
import store from '~/store';

function fileKeyOf(attachment: TAttachment): string | undefined {
  const { file_id, filepath } = attachment as Partial<TFile>;
  return file_id ?? filepath;
}

function toolCallIdOf(attachment: TAttachment): string | undefined {
  return (attachment as { toolCallId?: string }).toolCallId;
}

function agentIdOf(attachment: TAttachment): string | undefined {
  return (attachment as { agentId?: string }).agentId;
}

/**
 * Stable identity for merging DB and live attachments. Shared with the
 * message renderer, which dedupes the same rows on the same key — two
 * definitions of what makes an attachment "the same one" is exactly the drift
 * that puts a file on screen twice in one surface and not at all in another.
 */
const attachmentKey = attachmentIdentity;

/**
 * Wildcard-tolerant match for the lifecycle overlay: a missing `toolCallId`
 * or `agentId` on either side matches (preview-sync records are bare
 * `{file_id, ...}`); only DISTINCT values keep same-file entries separate.
 */
function matchesLiveEntry(db: TAttachment, live: TAttachment): boolean {
  const key = fileKeyOf(db);
  if (!key || fileKeyOf(live) !== key) {
    return false;
  }
  const dbToolCallId = toolCallIdOf(db);
  const liveToolCallId = toolCallIdOf(live);
  if (dbToolCallId != null && liveToolCallId != null && dbToolCallId !== liveToolCallId) {
    return false;
  }
  const dbAgentId = agentIdOf(db);
  const liveAgentId = agentIdOf(live);
  return dbAgentId == null || liveAgentId == null || dbAgentId === liveAgentId;
}

export default function useAttachments({
  messageId,
  attachments,
}: {
  messageId?: string;
  attachments?: TAttachment[];
}) {
  const messageAttachmentsMap = useRecoilValue(store.messageAttachmentsMap);
  const messageAttachments = useMemo<TAttachment[]>(() => {
    const live = messageAttachmentsMap[messageId ?? ''];
    if (!attachments || attachments.length === 0) {
      return live ?? [];
    }
    if (!live || live.length === 0) {
      return attachments;
    }
    /* DB-loaded attachments are the source of truth for which
     * attachments belong to this message, but live entries (from the
     * SSE handler / `useAttachmentPreviewSync` polling) carry fresher
     * lifecycle fields — `status`, `text`, `textFormat`,
     * `previewError`. Without this merge, the deferred-preview flow
     * would render "stuck pending" forever on a loaded conversation:
     * the message saved to DB at end-of-run has the immediate-persist
     * snapshot (`status: 'pending'`, `text: null`); the file record
     * itself updates to `'ready'` later, but the message's
     * `attachments` array doesn't get rewritten. Polling fetches the
     * resolved record into `messageAttachmentsMap`; merging here lets
     * `artifactTypeForAttachment` see the resolved text/textFormat
     * and route through the proper PanelArtifact card. */
    const dbKeys = new Set<string>();
    const merged = attachments.map((db) => {
      const key = attachmentKey(db);
      if (!key) {
        return db;
      }
      dbKeys.add(key);
      /** Partial live records must still be reachable by their less-specific
       *  keys so an overlaid entry isn't re-appended below: bare records (no
       *  toolCallId) key by plain file key, agent-less records by
       *  fileKey::toolCallId. */
      const fileKey = fileKeyOf(db);
      if (fileKey) {
        dbKeys.add(fileKey);
        const toolCallId = toolCallIdOf(db);
        if (toolCallId != null) {
          dbKeys.add(`${fileKey}::${toolCallId}`);
        }
      }
      const liveEntry = live.find((a) => matchesLiveEntry(db, a));
      return liveEntry ? ({ ...db, ...liveEntry } as TAttachment) : db;
    });
    /* Live-only entries with a stable identity are kept, not discarded: a
     * background code task's harvested files arrive via SSE anchored to a
     * message whose DB `attachments` snapshot predates them (the row is
     * patched post-finalize), so treating the DB list as exhaustive would
     * make those files vanish until a full reload. Entries whose key is
     * already in the DB list (e.g. unkeyed file_search citations replayed
     * by the final message event) are duplicates, and entries with no
     * stable identity at all cannot be deduped — both are dropped. */
    const liveOnly = live.filter((a) => {
      const key = attachmentKey(a);
      return key != null && !dbKeys.has(key);
    });
    return liveOnly.length > 0 ? [...merged, ...liveOnly] : merged;
  }, [attachments, messageAttachmentsMap, messageId]);

  const searchResults = useSearchResultsByTurn(messageAttachments);

  return {
    attachments: messageAttachments,
    searchResults,
  };
}
