import type { FinalMessageFields, ServerSentEvent } from '~/types';
import { sanitizeMessageForTransmit } from '~/utils/message';

function sanitizeFinalMessage(message: FinalMessageFields): FinalMessageFields {
  // Stream content has a wider protocol type than persisted message content.
  const { content, error, ...fields } = message;
  return {
    ...sanitizeMessageForTransmit(fields),
    ...(content !== undefined && { content }),
    ...(error !== undefined && { error }),
  };
}

/** Also applied when replaying stored events produced by an older server. */
export function sanitizeFinalEvent(event: ServerSentEvent): ServerSentEvent {
  if (!('final' in event)) {
    return event;
  }
  return {
    ...event,
    ...(event.requestMessage && { requestMessage: sanitizeFinalMessage(event.requestMessage) }),
    ...(event.responseMessage && { responseMessage: sanitizeFinalMessage(event.responseMessage) }),
    ...(event.runMessages && { runMessages: event.runMessages.map(sanitizeFinalMessage) }),
  };
}
