import { useRef, useMemo, useCallback } from 'react';
import { cn, useLocalize } from '@librechat/client';
import { EModelEndpoint } from 'librechat-data-provider';
import type { TConversation, TMessageContentParts } from 'librechat-data-provider';
import type { ReactElement } from 'react';
import type { ChildActivity } from '../../react/subagents/adapters';
import type { ChatScreenMessagesSlots } from '../pane/messages';
import type { FollowedChat } from '../../react/follow';
import { MessagePartsHostProvider, useMessagePartsHost } from '../../react/host';
import { ToolContentQueryContext } from '../../react/parts/disclosure';
import { useSubagentsHost } from '../../react/subagents/host';
import { getMessageRowWidthClass } from '../messages/width';
import { SubagentControlHistory } from './transcript';
import FollowedThread from '../pane/Followed';

/**
 * The pane number a followed child thread reports. The root pane is 0 and the added one is 1;
 * this is neither, so nothing a host keys by pane can be shared with a chat the reader drives.
 */
export const SUBAGENT_THREAD_PANE = 2;

export type FollowedChildThreadProps = {
  threadId: string;
  followed: FollowedChat;
  /** The agent the child runs as, which its replies are drawn for. */
  agentId?: string;
  /** The guidance sent to the task, as the task's durable view reports it. */
  controls?: ChildActivity['controls'];
  /** Earlier guidance than `controls` holds exists. */
  controlsTruncated?: boolean;
  /** Withdraws guidance the child has not taken yet; absent while it cannot be withdrawn. */
  onCancelControl?: (controlId: string) => void;
};

const noControls: NonNullable<ChildActivity['controls']> = [];

/**
 * A subagent's child thread drawn as a conversation: main chat's message list over the thread's
 * stored messages and the generation running under it. View-only, as the server keeps a child
 * thread; guidance for the child goes through the panel's composer.
 */
export default function FollowedChildThread({
  threadId,
  followed,
  agentId,
  controls = noControls,
  controlsTruncated = false,
  onCancelControl,
}: FollowedChildThreadProps): ReactElement {
  const localize = useLocalize();
  const host = useSubagentsHost();
  const partsHost = host.useChildPartsHost(useMessagePartsHost());
  const conversation = useMemo(
    () =>
      ({
        conversationId: threadId,
        endpoint: EModelEndpoint.agents,
        ...(agentId != null && { agent_id: agentId }),
      }) as TConversation,
    [threadId, agentId],
  );
  /** Every part the thread shows, which is where an applied steer already appears. */
  const shown = useMemo(
    () =>
      followed.messages.flatMap((message) =>
        (message.content ?? []).filter((part): part is TMessageContentParts => part != null),
      ),
    [followed.messages],
  );
  /** The panel hands a new handler on every render; the list's tail should not redraw for that. */
  const cancel = useRef(onCancelControl);
  cancel.current = onCancelControl;
  const withdraw = useCallback((controlId: string) => cancel.current?.(controlId), []);
  const canWithdraw = onCancelControl != null;
  /**
   * Guidance the child has not taken yet has no place in the thread: it sits after the last row,
   * where main chat draws its own pending steers, in the same column. Once the child takes it,
   * the stream places it in the reply and it leaves this list.
   */
  const slots = useMemo<ChatScreenMessagesSlots>(
    () => ({
      renderPendingSteers: ({ fullWidth }) =>
        controls.length === 0 && !controlsTruncated ? null : (
          <div
            data-subagent-pending-guidance
            className={cn('mx-auto min-w-0 px-4', getMessageRowWidthClass({ fullWidth }))}
          >
            <SubagentControlHistory
              controls={controls}
              content={shown}
              onCancelControl={canWithdraw ? withdraw : undefined}
            />
            {controlsTruncated && (
              <div className="text-text-secondary mb-3 text-xs italic">
                {localize('com_ui_subagent_control_history_truncated')}
              </div>
            )}
          </div>
        ),
    }),
    [canWithdraw, controls, controlsTruncated, localize, shown, withdraw],
  );
  if (followed.isLoading && followed.messages.length === 0) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="text-text-secondary flex flex-1 items-center justify-center pt-14 text-sm"
      >
        {localize('com_ui_loading')}
      </div>
    );
  }
  return (
    <MessagePartsHostProvider host={partsHost}>
      {/* `null` keeps tool calls as previews where the app gives no parent-scoped read: the
          ordinary message route answers 404 for a child thread. */}
      <ToolContentQueryContext.Provider value={host.useThreadToolContent ?? null}>
        {/* Main chat's rows take their side gutter from the viewport's width, and in a viewport
            wide enough to seat this panel beside a chat that is the narrow one meant for a
            centered column. The panel is not that column, so it supplies the rest of the gutter
            its own transcript has always had. */}
        <div className="flex min-h-0 flex-1 flex-col sm:px-2">
          <FollowedThread
            id={threadId}
            index={SUBAGENT_THREAD_PANE}
            followed={followed}
            conversation={conversation}
            slots={slots}
          />
        </div>
      </ToolContentQueryContext.Provider>
    </MessagePartsHostProvider>
  );
}
