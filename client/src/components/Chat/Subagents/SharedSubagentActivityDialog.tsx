import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useAtom } from 'jotai';
import { OGDialog, OGDialogContent, OGDialogHeader, OGDialogTitle } from '@librechat/client';
import { SubagentActivityScrollSurface } from './SubagentActivity';
import SubagentConversation from './SubagentConversation';
import { adaptLivePersistedActivity } from './adapters';
import { activeSubagentPanel } from './state';
import { useLocalize } from '~/hooks';

/** Public-share fallback for subagent activity already embedded in the shared message payload. */
export default function SharedSubagentActivityDialog({ shareId }: { shareId?: string }) {
  const localize = useLocalize();
  const [selected, setSelected] = useAtom(activeSubagentPanel);
  const resetSelection = useCallback(() => setSelected(null), [setSelected]);
  const selection = selected?.host === 'share' && selected.shareId === shareId ? selected : null;
  const restoreSelectionRef = useRef(selection);
  if (selection != null) restoreSelectionRef.current = selection;
  const title =
    selection?.subagentType === 'self'
      ? localize('com_ui_subagent_dialog_title_self')
      : localize('com_ui_subagent_dialog_title', { 0: selection?.subagentType ?? '' });
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
        <OGDialogHeader className="shrink-0 border-b border-border-light px-5 py-4 pr-14">
          <OGDialogTitle className="truncate text-left text-base" title={activity.title}>
            {activity.title}
          </OGDialogTitle>
        </OGDialogHeader>
        <SubagentActivityScrollSurface padded={false}>
          <SubagentConversation
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
      </OGDialogContent>
    </OGDialog>
  );
}
