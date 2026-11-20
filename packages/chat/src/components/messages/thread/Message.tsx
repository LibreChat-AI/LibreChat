import { isAssistantsEndpoint } from 'librechat-data-provider';
import type { ReactElement } from 'react';
import type { ThreadMessageProps } from '../../../react/messages/types';
import MessageContent from '../MessageContent';
import MessageParts from '../MessageParts';
import Message from '../Message';

/** One message row of the thread: assistants parts, content parts, or plain text. */
export default function ThreadMessage(props: ThreadMessageProps): ReactElement {
  const { message } = props;
  if (isAssistantsEndpoint(message.endpoint) && message.content) {
    return <MessageParts {...props} />;
  }
  if (message.content) {
    return <MessageContent {...props} />;
  }
  return <Message {...props} />;
}
