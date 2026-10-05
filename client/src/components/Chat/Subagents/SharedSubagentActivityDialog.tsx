import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useAtom } from 'jotai';
import { OGDialog, OGDialogContent, OGDialogHeader, OGDialogTitle } from '@librechat/client';
import type { TMessage } from 'librechat-data-provider';
import {
  isSelfSpawn as isSelfSpawnType,
  messageAuthor,
  findAgentLaneId,
  resolveSubagentAuthor,
  findAgentAuthorMessage,
} from './author';
import { MessageSurfaceContext } from '~/components/Chat/Messages/ui/surface';
import { SubagentActivityScrollSurface } from './SubagentActivity';
import SubagentConversation from './SubagentConversation';
import { adaptLivePersistedActivity } from './adapters';
import { resolveSubagentAgentId } from './identity';
import { useAgentsMapContext } from '~/Providers';
import { activeSubagentPanel } from './state';
import { useLocalize } from '~/hooks';

/** Public-share fallback for subagent activity already embedded in the shared message payload. */
export default function SharedSubagentActivityDialog({
  shareId,
  messages,
}: {
  shareId?: string;
  /** The shared thread, which names the agent that dispatched the child. */
  messages?: TMessage[];
}) {
  const localize = useLocalize();
  const agentsMap = useAgentsMapContext();
  const [selected, setSelected] = useAtom(activeSubagentPanel);
  const resetSelection = useCallback(() => setSelected(null), [setSelected]);
  const selection = selected?.host === 'share' && selected.shareId === shareId ? selected : null;
  const restoreSelectionRef = useRef(selection);
  if (selection != null) restoreSelectionRef.current = selection;
  const parentMessageId = selection?.parentMessageId ?? '';
  const parentFallback = localize('com_ui_subagent_parent_agent');
  /** Resolved only while a child is open: the shared thread is never scanned for
   *  a dialog nobody is looking at. */
  const parentAuthor = useMemo(() => {
    const message =
      parentMessageId === '' ? undefined : findAgentAuthorMessage(messages, parentMessageId);
    return messageAuthor(
      message,
      agentsMap,
      parentFallback,
      findAgentLaneId(message, selection?.toolCallId, selection?.partIndex),
    );
  }, [
    agentsMap,
    messages,
    parentFallback,
    parentMessageId,
    selection?.toolCallId,
    selection?.partIndex,
  ]);
  const childAgentId = resolveSubagentAgentId(null, selection?.subagentIdentity);
  const isSelfSpawn = isSelfSpawnType(
    selection?.subagentType,
    selection?.subagentIdentity?.subagentKind,
  );
  const childAuthor = useMemo(
    () =>
      resolveSubagentAuthor(
        {
          agentId: childAgentId,
          subagentType: selection?.subagentType,
          subagentKind: selection?.subagentIdentity?.subagentKind,
        },
        parentAuthor,
        agentsMap,
        localize('com_ui_subagent_actor'),
      ),
    [agentsMap, childAgentId, localize, parentAuthor, selection],
  );
  const title = childAuthor.name;
  const activity = useMemo(
    () =>
      adaptLivePersistedActivity({
        title,
        prompt: selection?.prompt,
        progress: null,
        persistedContent: selection?.persistedContent,
        legacyOutput: selection?.legacyOutput,
        initialProgress: selection?.initialProgress ?? 1,
        isSubmitting: false,
        runStepStatus: selection?.runStepStatus,
        approvalVisibility: 'hidden',
      }),
    [selection, title],
  );

  const restoreTriggerFocus = useCallback((event: Event) => {
    event.preventDefault();
    const selectionToRestore = restoreSelectionRef.current;
    if (selectionToRestore == null) return;
    requestAnimationFrame(() => {
      const trigger = Array.from(
        document.querySelectorAll<HTMLElement>('[data-subagent-tool-call]'),
      ).find(
        (element) =>
          element.dataset.subagentToolCall === selectionToRestore.toolCallId &&
          element.dataset.subagentParentMessage === selectionToRestore.parentMessageId &&
          element.dataset.subagentPartIndex === String(selectionToRestore.partIndex),
      );
      trigger?.focus();
    });
  }, []);

  useEffect(() => () => resetSelection(), [resetSelection]);
  useEffect(() => {
    if (selected?.host === 'share' && selected.shareId !== shareId) resetSelection();
  }, [resetSelection, selected, shareId]);

  return (
    <OGDialog open={selection != null} onOpenChange={(open) => !open && resetSelection()}>
      <OGDialogContent
        className="flex h-[min(90vh,48rem)] w-11/12 max-w-3xl flex-col gap-0 overflow-hidden p-0"
        onCloseAutoFocus={restoreTriggerFocus}
      >
        <OGDialogHeader className="border-border-light shrink-0 border-b px-5 py-4 pr-14">
          <div className="flex min-w-0 items-center gap-2">
            <span
              aria-hidden="true"
              className="flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-full"
            >
              {childAuthor.icon}
            </span>
            <OGDialogTitle className="truncate text-left text-base" title={title}>
              {title}
            </OGDialogTitle>
          </div>
        </OGDialogHeader>
        <MessageSurfaceContext.Provider value="bg-surface-dialog">
          <SubagentActivityScrollSurface padded={false}>
            <SubagentConversation
              author={childAuthor}
              parentAuthor={isSelfSpawn ? childAuthor : parentAuthor}
              turns={[
                {
                  taskId:
                    selection == null
                      ? 'shared-subagent'
                      : `${selection.parentMessageId}\u0000${selection.toolCallId}\u0000${selection.partIndex}`,
                  trigger: {
                    kind: 'parent_dispatch',
                    summary: selection?.prompt ?? '',
                  },
                  activity,
                },
              ]}
            />
          </SubagentActivityScrollSurface>
        </MessageSurfaceContext.Provider>
      </OGDialogContent>
    </OGDialog>
  );
}
