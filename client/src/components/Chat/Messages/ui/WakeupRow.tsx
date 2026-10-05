import { useMemo } from 'react';
import type { ComponentProps } from 'react';
import type { WakeupTask } from '../Content/Parts/wakeup';
import {
  messageAuthor,
  resolveSubagentAuthor,
  findAgentAuthorMessage,
  useParentAuthor,
} from '~/components/Chat/Subagents/author';
import { useParentSubagents } from '~/components/Chat/Subagents/ParentSubagentsProvider';
import { useOptionalMessagesOperations } from '~/Providers/MessagesViewContext';
import { findSubagentDispatch } from '~/components/Chat/Subagents/dispatch';
import { useShareContext } from '~/Providers/ShareContext';
import { useAgentsMapContext } from '~/Providers';
import MessageRow from './MessageRow';
import { useLocalize } from '~/hooks';

/** Only wake-up rows observe the child index; ordinary rows keep their subscriptions. */
export default function WakeupRow({
  task,
  conversationId,
  ...props
}: ComponentProps<typeof MessageRow> & { task?: WakeupTask; conversationId: string }) {
  const localize = useLocalize();
  const agentsMap = useAgentsMapContext();
  const { isSharedConvo } = useShareContext();
  const { getMessages } = useOptionalMessagesOperations();
  const { byThreadId } = useParentSubagents();
  const child = task?.threadId == null ? undefined : byThreadId.get(task.threadId);
  const dispatch = useMemo(
    () =>
      child == null ? findSubagentDispatch(getMessages(conversationId), task?.threadId) : undefined,
    [child, conversationId, getMessages, task?.threadId],
  );
  const parentMessageId = child?.parentMessageId ?? dispatch?.message.messageId ?? props.id ?? '';
  const fallbackName = localize('com_ui_subagent_actor');
  const privateParentAuthor = useParentAuthor(
    conversationId,
    isSharedConvo === true ? '' : parentMessageId,
    fallbackName,
    child?.parentToolCallId,
    undefined,
    isSharedConvo === true ? undefined : task?.threadId,
  );
  const parentAuthor = useMemo(
    () =>
      isSharedConvo === true
        ? messageAuthor(
            dispatch?.message ?? findAgentAuthorMessage(getMessages(), parentMessageId),
            agentsMap,
            fallbackName,
            dispatch?.agentId,
          )
        : privateParentAuthor,
    [
      agentsMap,
      fallbackName,
      getMessages,
      isSharedConvo,
      parentMessageId,
      privateParentAuthor,
      dispatch,
    ],
  );
  const author = useMemo(
    () =>
      resolveSubagentAuthor(
        {
          subagentType: child?.subagentType ?? dispatch?.subagentType ?? task?.subagentType,
          subagentKind: child?.subagentKind ?? dispatch?.identity?.subagentKind,
          agentId: child?.agentId ?? dispatch?.identity?.subagentAgentId,
          title: child?.title,
        },
        parentAuthor,
        agentsMap,
        fallbackName,
      ),
    [agentsMap, child, dispatch, fallbackName, parentAuthor, task?.subagentType],
  );
  return (
    <MessageRow
      {...props}
      icon={author.icon}
      label={author.name}
      hoverLabel={undefined}
      headerPrefix={undefined}
      showAuthor
      outlined
    />
  );
}
