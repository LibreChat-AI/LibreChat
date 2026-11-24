import { useMemo } from 'react';
import { useLocalize } from '@librechat/client';
import { isEphemeralAgentId } from 'librechat-data-provider';
import type {
  AgentDisplay,
  TMessage,
  Assistant,
  TAttachment,
  TConversation,
  SearchResultData,
} from 'librechat-data-provider';
import type { ReactNode } from 'react';
import type { MessageIconData } from '../../react/messages/host';
import { getHeaderPrefixForScreenReader, getMessageAriaLabel } from './labels';
import { ErrorSourceProvider } from '../../react/messages/error';
import { MessageIconSlot } from '../../react/messages/host';
import { AuthorContext } from '../../react/messages/author';
import { renderContentParts } from '../contentRenderer';
import { useMessagePartsHost } from '../../react/host';
import { getHeaderHoverLabel } from './HeaderLabel';
import MessageFooter from './MessageFooter';
import MessageRow from './MessageRow';

/** A message row whose body is its content parts: what the app's row hooks resolved for it. */
export type ContentRowProps = {
  message: TMessage;
  conversation: TConversation | null;
  /** The pane the row renders in. */
  index: number;
  /** The author's name, also the icon's model label. */
  label: string;
  iconData: MessageIconData;
  agent?: AgentDisplay;
  assistant?: Assistant;
  /** Whether the sender's name comes from configuration rather than the model. */
  hasConfiguredSender: boolean;
  /** Drops the avatar and name from a turn by the agent the header's model selector shows. */
  hideSelectedAuthor?: boolean;
  /** The sender a response sent under the conversation's current selection carries; one written
   *  under another spec on the same model carries another. */
  selectedSender?: string;
  isLast: boolean;
  isLatestMessage: boolean;
  isSubmitting: boolean;
  edit: boolean;
  enterEdit: (cancel?: boolean) => void;
  siblingIdx?: number;
  siblingCount?: number;
  setSiblingIdx?: ((value: number) => void) | null;
  attachments?: TAttachment[];
  searchResults?: Record<string, SearchResultData>;
  /** Whether the content lays out agent columns side by side, which widens the row. */
  hasParallelContent: boolean;
  /** Whether the viewer widened the chat to the full window. */
  fullWidth: boolean;
  /** The row's hover actions, drawn at the end of the footer (the package's `HoverButtons`). */
  toolbar: ReactNode;
  /** The header restated before content that resumes after a steer; assistant rows only. */
  authorHeader?: ReactNode;
  /** Client-only parent anchor carried by one response while its server identities hydrate. */
  renderOwnerId?: string;
  /** Forwarded to the parts as the time parallel column headers show. */
  createdAt?: string | null;
  /** Replaces the content parts, for a body the app draws itself (a private prompt). */
  body?: ReactNode;
  /** A message-level outcome drawn after the content. */
  notice?: ReactNode;
};

/** Whether a response came from the conversation's own selection: the saved agent the selector
 *  shows, or, with no saved agent, the spec or endpoint and model it runs, under the sender that
 *  selection writes. A turn by another agent, from another spec on the same model, a subagent's
 *  read-only thread (whose header has no selector), side-by-side agent columns and an added
 *  conversation (index > 0) all keep their author. A sender missing on either side, as on a
 *  response still streaming, does not tell the authors apart. */
function isSelectedAuthor({
  agent,
  index,
  message,
  assistant,
  conversation,
  selectedSender,
  hasParallelContent,
}: Pick<
  ContentRowProps,
  | 'agent'
  | 'index'
  | 'message'
  | 'assistant'
  | 'conversation'
  | 'selectedSender'
  | 'hasParallelContent'
>): boolean {
  if (message.isCreatedByUser === true || conversation == null) {
    return false;
  }
  if (conversation.subagentThread != null) {
    return false;
  }
  if (agent != null) {
    return agent.id === conversation.agent_id;
  }
  /** A spec or endpoint turn runs as an ephemeral agent, whose id the server saves on the
   *  conversation; only a saved agent is another author. */
  if (
    assistant != null ||
    (conversation.agent_id != null && !isEphemeralAgentId(conversation.agent_id))
  ) {
    return false;
  }
  return (
    index === 0 &&
    !hasParallelContent &&
    (message.endpoint ?? conversation.endpoint) === conversation.endpoint &&
    (message.model ?? conversation.model) === conversation.model &&
    (!message.sender || !selectedSender || message.sender === selectedSender)
  );
}

/**
 * The row of a message rendered from content parts: header, parts and footer (elapsed time,
 * sibling navigation and the caller's toolbar, through `MessageFooter`). The parts render through the host's content-parts
 * slot, inside the author and error-source contexts their headers and error cards read.
 */
export default function ContentRow({
  message,
  conversation,
  index,
  label,
  iconData,
  agent,
  assistant,
  hasConfiguredSender,
  hideSelectedAuthor = false,
  selectedSender,
  isLast,
  isLatestMessage,
  isSubmitting,
  edit,
  enterEdit,
  siblingIdx,
  siblingCount,
  setSiblingIdx,
  attachments,
  searchResults,
  hasParallelContent,
  fullWidth,
  toolbar,
  authorHeader,
  renderOwnerId,
  createdAt,
  body,
  notice,
}: ContentRowProps): ReactNode {
  const localize = useLocalize();
  const host = useMessagePartsHost();
  const showThinking = host.useShowThinking();
  const autoExpandTools = host.useAutoExpandTools();
  const isCreatedByUser = message.isCreatedByUser === true;
  const authorHidden =
    hideSelectedAuthor &&
    isSelectedAuthor({
      agent,
      index,
      message,
      assistant,
      conversation,
      selectedSender,
      hasParallelContent,
    });

  const author = useMemo(
    () => ({
      icon: <MessageIconSlot iconData={iconData} assistant={assistant} agent={agent} />,
      label,
    }),
    [iconData, assistant, agent, label],
  );

  return (
    <MessageRow
      message={message}
      id={message.messageId}
      icon={author.icon}
      label={author.label}
      hoverLabel={getHeaderHoverLabel(
        hasConfiguredSender,
        agent?.model,
        assistant?.model,
        message.model,
        conversation?.model,
      )}
      authorHidden={authorHidden}
      timestamp={message.createdAt ?? message.clientTimestamp}
      ariaLabel={getMessageAriaLabel(message, localize)}
      headerPrefix={getHeaderPrefixForScreenReader(message, localize)}
      isCreatedByUser={isCreatedByUser}
      hasParallelContent={hasParallelContent}
      fullWidth={fullWidth}
      isEditing={edit}
      footer={
        <MessageFooter
          index={index}
          isSubmitting={isSubmitting}
          isLatestMessage={isLatestMessage}
          isCreatedByUser={message.isCreatedByUser}
          isUserSide={isCreatedByUser}
          siblingIdx={siblingIdx}
          siblingCount={siblingCount}
          setSiblingIdx={setSiblingIdx}
          toolbar={toolbar}
        />
      }
    >
      <AuthorContext.Provider value={author}>
        <ErrorSourceProvider message={message}>
          {body ??
            (host.renderContentParts ?? renderContentParts)({
              edit,
              isLast,
              enterEdit,
              siblingIdx,
              attachments,
              searchResults,
              isSubmitting,
              isLatestMessage,
              isCreatedByUser,
              renderOwnerId,
              createdAt,
              showThinking,
              authorHeader: isCreatedByUser || authorHidden ? undefined : authorHeader,
              setSiblingIdx,
              messageId: message.messageId,
              manualSkills: message.manualSkills,
              foldLiveActivity: !autoExpandTools,
              conversationId: conversation?.conversationId ?? null,
              content: message.content ?? [],
            })}
        </ErrorSourceProvider>
      </AuthorContext.Provider>
      {notice}
    </MessageRow>
  );
}
