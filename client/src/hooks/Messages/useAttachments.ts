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

function nonFileBucketKey(attachment: TAttachment): string | undefined {
  if (fileKeyOf(attachment)) {
    return undefined;
  }
  const { type } = attachment as { type?: string };
  const toolCallId = toolCallIdOf(attachment);
  return type != null && toolCallId != null ? `${type}:${toolCallId}` : undefined;
}

/** Missing ownership is a compatibility wildcard for historical rows; two
 * known unequal owners identify distinct executions. */
function nonFileOwnersCompatible(left: TAttachment, right: TAttachment): boolean {
  const leftAgentId = agentIdOf(left);
  const rightAgentId = agentIdOf(right);
  const leftStepId = left.stepId;
  const rightStepId = right.stepId;
  return (
    (leftAgentId == null || rightAgentId == null || leftAgentId === rightAgentId) &&
    (leftStepId == null || rightStepId == null || leftStepId === rightStepId)
  );
}

/** Stable file identity shared with the message renderer. Non-file DB/live
 * reconciliation additionally compares its producer ownership below. */
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
    const nonFileBuckets = new Map<string, TAttachment[]>();
    const merged = attachments.map((db) => {
      const key = attachmentKey(db);
      if (!key) {
        return db;
      }
      const fileKey = fileKeyOf(db);
      if (fileKey) {
        /** Partial live file records must still be reachable by their
         * less-specific keys so an overlaid entry isn't re-appended below:
         * bare records key by file key, and agent-less records by
         * fileKey::toolCallId. */
        dbKeys.add(key);
        dbKeys.add(fileKey);
        const toolCallId = toolCallIdOf(db);
        if (toolCallId != null) {
          dbKeys.add(`${fileKey}::${toolCallId}`);
        }
      } else {
        const bucketKey = nonFileBucketKey(db);
        if (bucketKey) {
          const bucket = nonFileBuckets.get(bucketKey) ?? [];
          bucket.push(db);
          nonFileBuckets.set(bucketKey, bucket);
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
     * compatible DB file key or non-file owner are replay duplicates, while
     * entries with no stable identity at all cannot be reconciled — both are
     * dropped. */
    const liveOnly = live.filter((a) => {
      const key = attachmentKey(a);
      if (key == null) {
        return false;
      }
      if (fileKeyOf(a)) {
        return !dbKeys.has(key);
      }
      const bucketKey = nonFileBucketKey(a);
      if (!bucketKey) {
        return false;
      }
      return !nonFileBuckets.get(bucketKey)?.some((db) => nonFileOwnersCompatible(db, a));
    });
    return liveOnly.length > 0 ? [...merged, ...liveOnly] : merged;
  }, [attachments, messageAttachmentsMap, messageId]);

  const searchResults = useSearchResultsByTurn(messageAttachments);

  return {
    attachments: messageAttachments,
    searchResults,
  };
}
