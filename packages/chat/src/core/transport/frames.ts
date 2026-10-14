import {
  UsageEvents,
  SteerEvents,
  ApprovalEvents,
  ActivityLabelEvents,
  ReasoningLabelEvents,
} from 'librechat-data-provider';
import type {
  ChatFrame,
  ChatEvent,
  ChatSyncFrame,
  ChatTextFrame,
  ChatEventFrame,
  ChatFinalFrame,
  ChatContentFrame,
  ChatCreatedFrame,
} from 'librechat-data-provider';

/** The keys the server discriminates frames by, in the order they are checked. */
type FrameKeys = {
  final?: unknown;
  created?: unknown;
  event?: unknown;
  sync?: unknown;
  type?: unknown;
  message?: unknown;
};

function normalizeEventFrame(frame: ChatEventFrame): ChatEvent {
  switch (frame.event) {
    case 'title':
      return { type: 'title', data: frame };
    case 'attachment':
      return { type: 'attachment', data: frame.data };
    case UsageEvents.ON_CONTEXT_USAGE:
      return { type: 'context_usage', data: frame.data };
    case UsageEvents.ON_TOKEN_USAGE:
      return { type: 'token_usage', data: frame.data };
    case ApprovalEvents.ON_PENDING_ACTION:
      return { type: 'pending_action', data: frame.data };
    case SteerEvents.ON_STEER_APPLIED:
      return { type: 'steer_applied', data: frame.data };
    case SteerEvents.ON_STEER_UPDATED:
      return { type: 'steer_updated', data: frame.data };
    case ActivityLabelEvents.ON_ACTIVITY_LABEL:
      return { type: 'activity_label', data: frame.data };
    case ReasoningLabelEvents.ON_REASONING_LABEL:
      return { type: 'reasoning_label', data: frame.data };
    case ReasoningLabelEvents.ON_REASONING_LABEL_ATTEMPT:
      return { type: 'reasoning_label_attempt', data: frame.data };
    default:
      return { type: 'step', data: frame };
  }
}

/**
 * Tags one `message` frame by the keys the server wrote, checked in the order
 * the stream hooks have always checked them: a frame carrying both `final`
 * and `event` is final. An `event` the client does not name is a step event,
 * so the step handler keeps seeing new graph events as it did before. A frame
 * with none of the keys returns `undefined`.
 */
export function normalizeFrame(frame: ChatFrame): ChatEvent | undefined {
  const keys: FrameKeys = frame;
  if (keys.final != null) {
    return { type: 'final', data: frame as ChatFinalFrame };
  }
  if (keys.created != null) {
    return { type: 'created', data: frame as ChatCreatedFrame };
  }
  if (keys.event != null) {
    return normalizeEventFrame(frame as ChatEventFrame);
  }
  if (keys.sync != null) {
    return { type: 'sync', data: frame as ChatSyncFrame };
  }
  if (keys.type != null) {
    return { type: 'content', data: frame as ChatContentFrame };
  }
  if (keys.message != null) {
    return { type: 'text', data: frame as ChatTextFrame };
  }
  return undefined;
}
