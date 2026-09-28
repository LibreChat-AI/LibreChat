import { useSetRecoilState } from 'recoil';
import { QueryKeys, Tools } from 'librechat-data-provider';
import type {
  MemoriesResponse,
  EventSubmission,
  TAttachment,
  TFile,
} from 'librechat-data-provider';
import type { QueryClient } from '@tanstack/react-query';
import { handleMemoryArtifact } from '~/utils/memory';
import store from '~/store';

/** Identity of a re-emitted web-search snapshot: its tool call, turn, agent,
 *  and host step. Scoped to `web_search` because that is the flow whose server
 *  helper rebuilds and rewrites the whole payload on each highlight. The
 *  provider reuses ids such as `call_0` across turns and the host can reuse a
 *  turn number within one message, so the SDK step is part of the identity. */
const searchSnapshotKeyOf = (attachment: TAttachment): string | undefined => {
  if (attachment.type !== Tools.web_search) {
    return undefined;
  }
  const toolCallId = (attachment as { toolCallId?: string }).toolCallId;
  if (!toolCallId) {
    return undefined;
  }
  const agentId = (attachment as { agentId?: string }).agentId ?? '';
  const turn = attachment[Tools.web_search]?.turn;
  const stepId = attachment.stepId ?? '';
  return `${Tools.web_search}:${agentId}:${toolCallId}:${turn ?? 0}:${stepId}`;
};

export default function useAttachmentHandler(queryClient?: QueryClient) {
  const setAttachmentsMap = useSetRecoilState(store.messageAttachmentsMap);

  return ({ data }: { data: TAttachment; submission: EventSubmission }) => {
    const { messageId } = data;
    const fileId = (data as Partial<TFile>).file_id;

    const fileData = data as TFile;
    if (
      queryClient &&
      fileData?.file_id &&
      fileData?.filepath &&
      !fileData.filepath.includes('/api/files')
    ) {
      queryClient.setQueryData([QueryKeys.files], (oldData: TFile[] | undefined) => {
        if (!oldData) {
          return [fileData];
        }
        const existingIndex = oldData.findIndex((file) => file.file_id === fileData.file_id);
        if (existingIndex > -1) {
          const updated = [...oldData];
          updated[existingIndex] = { ...oldData[existingIndex], ...fileData };
          return updated;
        }
        return [fileData, ...oldData];
      });
    }

    if (queryClient && data.type === Tools.memory && data[Tools.memory]) {
      const memoryArtifact = data[Tools.memory];

      queryClient.setQueryData([QueryKeys.memories], (oldData: MemoriesResponse | undefined) => {
        if (!oldData) {
          return oldData;
        }

        return handleMemoryArtifact({ memoryArtifact, currentData: oldData }) || oldData;
      });
    }

    /* Cross-turn filename reuse keeps the same `file_id` across runs.
     * If a prior turn left `[QueryKeys.filePreview, file_id]` cached at
     * `status: 'ready'`, a new pending attachment would mount against
     * that stale cache and `useFilePreview`'s `refetchInterval` (which
     * only polls on `pending`) would never start. Drop the cache entry
     * entirely so a fresh mount has nothing to read and must fetch.
     *
     * `removeQueries` (vs the earlier `invalidateQueries`) is the
     * stronger fix: invalidate only marks data stale, but
     * `refetchOnMount: false` was masking that — the new observer
     * read the stale 'ready' value and `refetchInterval` shut polling
     * off before it ever started. (Codex P1 round-3 review on
     * PR #12957.) */
    if (queryClient && fileId) {
      queryClient.removeQueries([QueryKeys.filePreview, fileId]);
    }

    setAttachmentsMap((prevMap) => {
      const messageAttachments =
        (prevMap as Record<string, TAttachment[] | undefined>)[messageId] || [];
      /* Upsert by `file_id` (falling back to `filepath` for keyed entries
       * without one, e.g. code download fallbacks a background poll
       * re-emits), SCOPED by toolCallId — sibling code calls can share a
       * claimed file_id for the same filename, and each card anchors its
       * own attachment. The deferred-preview flow emits the same
       * attachment twice: first with `status: 'pending'` and `text:
       * null`, then again with `status: 'ready'` (and text/textFormat) or
       * `'failed'` (with previewError). The second event must merge over
       * the first in place — appending would render the artifact card
       * twice, once stuck pending and once resolved. Attachments with no
       * file key (lightweight types like web_search / file_search
       * citations) keep the legacy append behavior. */
      const fileKeyOf = (a: TAttachment): string | undefined => {
        const { file_id, filepath } = a as Partial<TFile>;
        return file_id ?? filepath;
      };
      const agentIdOf = (a: TAttachment): string | undefined => (a as { agentId?: string }).agentId;
      const upsertKey = fileKeyOf(data);
      const incomingToolCallId = (data as { toolCallId?: string }).toolCallId;
      const incomingAgentId = agentIdOf(data);
      if (upsertKey) {
        /** A missing toolCallId on either side is a wildcard (deferred-preview
         *  updates emit bare `{file_id, status}` payloads); only DISTINCT
         *  toolCallIds keep entries separate — sibling code calls can share a
         *  claimed file_id and each card anchors its own attachment. The same
         *  wildcard applies to agentId: handoff agents can repeat provider
         *  tool ids (`call_0`) AND share a claimed file_id, so distinct
         *  non-null agentIds must stay separate entries or the second agent's
         *  event would merge over (and re-badge) the first's. */
        const existingIndex = messageAttachments.findIndex((a) => {
          if (fileKeyOf(a) !== upsertKey) {
            return false;
          }
          const existingToolCallId = (a as { toolCallId?: string }).toolCallId;
          if (
            existingToolCallId != null &&
            incomingToolCallId != null &&
            existingToolCallId !== incomingToolCallId
          ) {
            return false;
          }
          const existingAgentId = agentIdOf(a);
          return (
            existingAgentId == null ||
            incomingAgentId == null ||
            existingAgentId === incomingAgentId
          );
        });
        if (existingIndex > -1) {
          const existing = messageAttachments[existingIndex] as Partial<TFile>;
          const incoming = data as Partial<TFile>;
          const next = { ...existing, ...data } as TAttachment;
          /* Don't let a phase-1 replay (finalHandler iterates
           * `responseMessage.attachments`, which is the immediate-persist
           * snapshot at status:pending) regress a record a deferred
           * update has already moved to ready/failed. Pin the terminal
           * lifecycle fields when the merge would downgrade. */
          if (
            (existing.status === 'ready' || existing.status === 'failed') &&
            incoming.status === 'pending'
          ) {
            (next as Partial<TFile>).status = existing.status;
            (next as Partial<TFile>).text = existing.text;
            (next as Partial<TFile>).textFormat = existing.textFormat;
            (next as Partial<TFile>).previewError = existing.previewError;
          }
          const merged = [...messageAttachments];
          merged[existingIndex] = next;
          return { ...prevMap, [messageId]: merged };
        }
      }
      /** Search attachments are full snapshots rather than deltas: the server
       *  re-emits the entire payload after every highlight update, keeping the
       *  same type, toolCallId and turn. They carry no `file_id`, so the upsert
       *  above never saw them and each snapshot was appended, stacking one copy
       *  of every image, product and place per update. Replace the previous
       *  snapshot in place; a wholesale swap is right because the incoming
       *  payload is complete. */
      const searchSnapshotKey = searchSnapshotKeyOf(data);
      if (searchSnapshotKey) {
        const existingIndex = messageAttachments.findIndex(
          (a) => searchSnapshotKeyOf(a) === searchSnapshotKey,
        );
        if (existingIndex > -1) {
          const merged = [...messageAttachments];
          merged[existingIndex] = data;
          return { ...prevMap, [messageId]: merged };
        }
      }
      return {
        ...prevMap,
        [messageId]: [...messageAttachments, data],
      };
    });
  };
}
