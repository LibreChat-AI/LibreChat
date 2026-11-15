import { useMemo } from 'react';
import { useLocalize } from '@librechat/client';
import { EModelEndpoint } from 'librechat-data-provider';
import type { TConversation } from 'librechat-data-provider';
import type { ReactElement } from 'react';
import type { FollowedChat } from '../../react/follow';
import { MessagePartsHostProvider, useMessagePartsHost } from '../../react/host';
import { ToolContentQueryContext } from '../../react/parts/disclosure';
import { useSubagentsHost } from '../../react/subagents/host';
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
};

/**
 * A subagent's child thread drawn as a conversation: main chat's message list over the thread's
 * stored messages and the generation running under it. View-only, as the server keeps a child
 * thread; guidance for the child goes through the panel's composer.
 */
export default function FollowedChildThread({
  threadId,
  followed,
  agentId,
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
        <FollowedThread
          id={threadId}
          index={SUBAGENT_THREAD_PANE}
          followed={followed}
          conversation={conversation}
        />
      </ToolContentQueryContext.Provider>
    </MessagePartsHostProvider>
  );
}
