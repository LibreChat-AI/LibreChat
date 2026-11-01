import { isAssistantsEndpoint } from 'librechat-data-provider';
import type { MessageRowSlotProps } from '@librechat/chat/react';
import MessageContent from '~/components/Messages/MessageContent';
import MessageParts from '../MessageParts';
import Message from '../Message';

/** The app's message row for the thread: assistants parts, content parts, or plain text. */
export default function ThreadMessage(props: MessageRowSlotProps) {
  const { message } = props;
  if (isAssistantsEndpoint(message.endpoint) && message.content) {
    return <MessageParts {...props} />;
  }
  if (message.content) {
    return <MessageContent {...props} />;
  }
  return <Message {...props} />;
}
