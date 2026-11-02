import { useMemo } from 'react';
import { useLocalize } from '@librechat/client';
import type {
  Agent,
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
  agent?: Agent;
  assistant?: Assistant;
  /** Whether the sender's name comes from configuration rather than the model. */
  hasConfiguredSender: boolean;
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
            host.renderContentParts({
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
              authorHeader: isCreatedByUser ? undefined : authorHeader,
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
