import { Suspense, useMemo, Fragment } from 'react';
import { useRecoilValue } from 'recoil';
import { DelayedRender } from '@librechat/client';
import { ContentTypes } from 'librechat-data-provider';
import type {
  Agents,
  TMessage,
  TAttachment,
  SearchResultData,
  TMessageContentParts,
} from 'librechat-data-provider';
import type { ReactNode, ReactElement } from 'react';
import { ErrorSourceProvider } from '~/components/Messages/Content/Error/source';
import { MessageContext, SearchContext, useMessageContext } from '~/Providers';
import { ErrorMessage, UnfinishedMessage } from './MessageContent';
import { cn, mapAttachments } from '~/utils';
import MarkdownLite from './MarkdownLite';
import { AgentUpdate } from './Parts';
import store from '~/store';
import Part from './Part';

/**
 * Whether this message falls through to the unconditional `MarkdownLite`
 * branch below, which renders markdown for either author regardless of
 * `enableUserMsgMarkdown`. Callers that copy the message need the same answer.
 */
export const rendersMarkdownLite = (message: TMessage): boolean =>
  message.error !== true && (!Array.isArray(message.content) || message.content.length === 0);

const SearchContent = ({
  message,
  attachments,
  searchResults,
  authorHeader,
}: {
  message: TMessage;
  attachments?: TAttachment[];
  searchResults?: { [key: string]: SearchResultData };
  /** Author icon + label re-rendered before content that resumes after an inline steer. */
  authorHeader?: ReactNode;
}) => {
  const enableUserMsgMarkdown = useRecoilValue(store.enableUserMsgMarkdown);
  const messageContext = useMessageContext();
  const { messageId } = message;

  const attachmentMap = useMemo(() => mapAttachments(attachments ?? []), [attachments]);

  if (Array.isArray(message.content) && message.content.length > 0) {
    const parts = message.content.filter((part): part is TMessageContentParts => part != null);
    /** Active agent from the latest preceding AGENT_UPDATE: post-steer content
     *  after a handoff belongs to that agent, not the message-level author.
     *  Captured BEFORE the current part's own handoff applies, mirroring
     *  `ContentParts`' `postSteerAuthors` scan. */
    let activeAgentId: string | undefined;
    return (
      <ErrorSourceProvider message={message}>
        <SearchContext.Provider value={{ searchResults }}>
          {parts.map((part: TMessageContentParts, idx: number) => {
            const toolCallId =
              (part?.[ContentTypes.TOOL_CALL] as Agents.ToolCall | undefined)?.id ?? '';
            const partAttachments = attachmentMap[toolCallId];
            const resumesAfterSteer =
              authorHeader != null &&
              idx > 0 &&
              parts[idx - 1].type === ContentTypes.STEER &&
              part.type !== ContentTypes.STEER;
            const resumeAgentId = resumesAfterSteer ? activeAgentId : undefined;
            if (part.type === ContentTypes.AGENT_UPDATE) {
              activeAgentId = part[ContentTypes.AGENT_UPDATE]?.agentId || undefined;
            }
            const partElement: ReactElement = (
              <Part
                key={`display-${messageId}-${idx}`}
                showCursor={false}
                isSubmitting={false}
                isCreatedByUser={message.isCreatedByUser}
                attachments={partAttachments}
                part={part}
              />
            );
            /** An error part resolves the agent a handoff made active from its own position,
             *  which it reads from `MessageContext`; persisted content is compacted, so `idx` is
             *  that position in `message.content`. */
            const rendered: ReactElement =
              part.type === ContentTypes.ERROR ? (
                <MessageContext.Provider
                  key={`display-${messageId}-${idx}`}
                  value={{ ...messageContext, partIndex: idx }}
                >
                  {partElement}
                </MessageContext.Provider>
              ) : (
                partElement
              );
            if (!resumesAfterSteer) {
              return rendered;
            }
            return (
              <Fragment key={`display-${messageId}-${idx}`}>
                {resumeAgentId != null ? (
                  <AgentUpdate currentAgentId={resumeAgentId} />
                ) : (
                  authorHeader
                )}
                {rendered}
              </Fragment>
            );
          })}
          {message.unfinished === true && (
            <Suspense>
              <DelayedRender delay={250}>
                <UnfinishedMessage message={message} key={`unfinished-${messageId}`} />
              </DelayedRender>
            </Suspense>
          )}
        </SearchContext.Provider>
      </ErrorSourceProvider>
    );
  }

  /** A failed row persists its failure as text, which only the error dispatcher can read. */
  if (message.error === true) {
    return <ErrorMessage message={message} text={message.text ?? ''} />;
  }

  return (
    <div
      className={cn(
        'markdown prose dark:prose-invert light w-full break-words',
        message.isCreatedByUser && !enableUserMsgMarkdown && 'whitespace-pre-wrap',
        'text-text-primary',
      )}
      dir="auto"
    >
      <MarkdownLite content={message.text || ''} />
    </div>
  );
};

export default SearchContent;
