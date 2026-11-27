import React from 'react';
import type { NamedExoticComponent, ReactElement } from 'react';
import type { TMessageProps } from '../../react/messages/types';
import useMemoizedChatContext from '../../react/messages/useMemoizedChatContext';
import useMessageProcess from '../../react/messages/useMessageProcess';
import { areMessageRowPropsEqual } from '../../react/messages/equal';
import MessageRender from './MessageRender';

const MessageContainer = React.memo(function MessageContainer({
  handleScroll,
  children,
}: {
  handleScroll: (event?: unknown) => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="text-text-primary w-full border-0 bg-transparent"
      onWheel={handleScroll}
      onTouchMove={handleScroll}
    >
      {children}
    </div>
  );
});

function Message(props: TMessageProps): ReactElement | null {
  const { handleScroll, isSubmitting } = useMessageProcess({
    message: props.message,
  });
  const { message } = props;
  const { chatContext, effectiveIsSubmitting, latestMessageId, latestMessageDepth } =
    useMemoizedChatContext(message, isSubmitting);

  if (!message || typeof message !== 'object') {
    return null;
  }

  return (
    <MessageContainer handleScroll={handleScroll}>
      <div className="m-auto justify-center px-4 py-3 sm:px-0">
        <MessageRender
          {...props}
          chatContext={chatContext}
          isSubmitting={effectiveIsSubmitting}
          latestMessageId={latestMessageId}
          latestMessageDepth={latestMessageDepth}
        />
      </div>
    </MessageContainer>
  );
}

const MemoizedMessage: NamedExoticComponent<TMessageProps> = React.memo(
  Message,
  areMessageRowPropsEqual,
);

export default MemoizedMessage;
