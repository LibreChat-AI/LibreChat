import { ContentTypes, stripReasoningLabelMetadata } from 'librechat-data-provider';
import type { TMessage, TMessageContentParts, TReasoningLabelEvent } from 'librechat-data-provider';

/** Resolves the assistant response targeted by a reasoning-label update. */
export function findReasoningLabelMessageIndex(
  messages: TMessage[],
  event: TReasoningLabelEvent,
): number {
  const isAssistant = (message: TMessage | undefined) => message?.isCreatedByUser === false;
  if (event.responseMessageId) {
    return messages.findIndex(
      (message) => message.messageId === event.responseMessageId && isAssistant(message),
    );
  }
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (isAssistant(messages[i])) {
      return i;
    }
  }
  return -1;
}

/** Applies a monotonic title revision to an existing THINK part without moving it. */
export function applyReasoningLabel(message: TMessage, event: TReasoningLabelEvent): TMessage {
  if (event.index < 0 || !Number.isInteger(event.index)) {
    return message;
  }
  const content = Array.isArray(message.content) ? message.content : [];
  if (event.reset === true) {
    const existing = content[event.index];
    if (
      existing?.type !== ContentTypes.THINK ||
      existing.reasoning_label_step_id !== event.previousStepId
    ) {
      return message;
    }
    const attempts = event.attempts ?? existing.reasoning_label_attempts;
    const alreadyReset =
      existing.reasoning_label_step_id === event.stepId &&
      existing.reasoning_label == null &&
      existing.reasoning_label_revision == null &&
      existing.reasoning_label_status == null &&
      existing.reasoning_label_submitted_chars == null &&
      existing.reasoning_label_attempts === attempts;
    if (alreadyReset) {
      return message;
    }
    const resetPart = stripReasoningLabelMetadata(existing) as typeof existing;
    const nextContent = [...content] as TMessageContentParts[];
    nextContent[event.index] = {
      ...resetPart,
      reasoning_label_step_id: event.stepId,
      ...(attempts != null && { reasoning_label_attempts: attempts }),
    };
    return { ...message, content: nextContent };
  }
  if (!event.label.trim()) {
    return message;
  }
  let targetIndex = event.index;
  let existing = content[targetIndex];
  if (
    existing?.type !== ContentTypes.THINK ||
    (existing.reasoning_label_step_id != null && existing.reasoning_label_step_id !== event.stepId)
  ) {
    targetIndex = content.findIndex(
      (part) => part?.type === ContentTypes.THINK && part.reasoning_label_step_id === event.stepId,
    );
    existing = content[targetIndex];
  }
  if (existing?.type !== ContentTypes.THINK) {
    return message;
  }
  /** Revisions are scoped to one SDK reasoning step. The stream handler clears
   *  old metadata when edit/regenerate folds a new step into a retained slot;
   *  an unowned THINK part therefore starts at revision zero. */
  const sameStep = existing.reasoning_label_step_id === event.stepId;
  const currentRevision = sameStep ? (existing.reasoning_label_revision ?? 0) : 0;
  if (event.revision < currentRevision) {
    return message;
  }
  if (
    sameStep &&
    event.revision === currentRevision &&
    (existing.reasoning_label !== event.label ||
      (existing.reasoning_label_status === 'complete' && event.status === 'streaming'))
  ) {
    return message;
  }
  if (
    existing.reasoning_label === event.label &&
    existing.reasoning_label_step_id === event.stepId &&
    existing.reasoning_label_revision === event.revision &&
    existing.reasoning_label_status === event.status
  ) {
    return message;
  }
  const nextContent = [...content] as TMessageContentParts[];
  nextContent[targetIndex] = {
    ...existing,
    reasoning_label: event.label,
    reasoning_label_step_id: event.stepId,
    reasoning_label_revision: event.revision,
    reasoning_label_status: event.status,
  };
  return { ...message, content: nextContent };
}
