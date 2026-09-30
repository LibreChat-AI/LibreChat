import React from 'react';
import type { TMessageProps } from '~/common';
import { useMessageProcess, useMemoizedChatContext } from '~/hooks';
import { areMessageRowPropsEqual } from '~/utils';
import MessageRender from './ui/MessageRender';

const MessageContainer = React.memo(function MessageContainer({
  handleScroll,
  children,
}: {
  handleScroll: (event?: unknown) => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="w-full border-0 bg-transparent text-text-primary"
      onWheel={handleScroll}
      onTouchMove={handleScroll}
    >
      {children}
    </div>
  );
});

function Message(props: TMessageProps) {
  const { handleScroll, isSubmitting } = useMessageProcess({
    message: props.message,
  });
  const { message } = props;
  const { chatContext, effectiveIsSubmitting } = useMemoizedChatContext(message, isSubmitting);

  if (!message || typeof message !== 'object') {
    return null;
  }

  return (
    <MessageContainer handleScroll={handleScroll}>
     <div className="m-auto justify-center px-4 py-3 sm:px-0 overflow-hidden break-words">
        <MessageRender {...props} isSubmitting={effectiveIsSubmitting} chatContext={chatContext} />
      </div>
    </MessageContainer>
  );
}

export default React.memo(Message, areMessageRowPropsEqual);
