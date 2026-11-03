import { useMemo } from 'react';
import { useLocalize } from '@librechat/client';
import type { ComponentProps, ReactElement } from 'react';
import type { Agent } from 'librechat-data-provider';
import type { WakeupTask } from '../../core/parts/wakeup';
import {
  messageAuthor,
  useParentAuthor,
  resolveSubagentAuthor,
  findAgentAuthorMessage,
} from '../../react/subagents/author';
import { findSubagentDispatch } from '../../core/subagents/dispatch';
import { useParentSubagents } from '../../react/subagents/parents';
import { useMessagesHost } from '../../react/messages/host';
import { useMessagePartsHost } from '../../react/host';
import MessageRow from './MessageRow';

/** Only wake-up rows observe the child index; ordinary rows keep their subscriptions. */
export default function WakeupRow({
  task,
  conversationId,
  agentsMap,
  ...props
}: ComponentProps<typeof MessageRow> & {
  task?: WakeupTask;
  conversationId: string;
  /** The viewer's agents by id, for naming and drawing a turn's author; undefined until loaded. */
  agentsMap: Record<string, Agent | undefined> | undefined;
}): ReactElement {
  const localize = useLocalize();
  const { isSharedConvo } = useMessagePartsHost().useShare();
  const getMessages = useMessagesHost().useGetMessages();
  const { byThreadId } = useParentSubagents();
  const child = task?.threadId == null ? undefined : byThreadId.get(task.threadId);
  const dispatch = useMemo(
    () => (child == null ? findSubagentDispatch(getMessages(), task?.threadId) : undefined),
    [child, getMessages, task?.threadId],
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
