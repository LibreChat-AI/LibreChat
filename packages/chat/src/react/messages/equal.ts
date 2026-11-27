import type { TMessage } from 'librechat-data-provider';
import type { TMessageProps } from './types';

export function areMessageFilesEqual(
  prevFiles?: TMessage['files'],
  nextFiles?: TMessage['files'],
): boolean {
  if (prevFiles === nextFiles) {
    return true;
  }
  const prevLength = prevFiles?.length ?? 0;
  const nextLength = nextFiles?.length ?? 0;
  if (prevLength !== nextLength) {
    return false;
  }
  if (prevLength === 0) {
    return true;
  }
  return prevFiles?.every((file, index) => file === nextFiles?.[index]) ?? true;
}

/**
 * Field-level equality for `message` props: `buildTree` mints a new node object
 * for EVERY message on each streaming update, so memo comparators must diff the
 * fields that drive rendering instead of the object reference.
 */
export function areMessageFieldsEqual(
  prevMsg?: TMessage | null,
  nextMsg?: TMessage | null,
): boolean {
  if (prevMsg === nextMsg) {
    return true;
  }
  if (!prevMsg || !nextMsg) {
    return false;
  }

  return (
    prevMsg.messageId === nextMsg.messageId &&
    prevMsg.text === nextMsg.text &&
    prevMsg.privacyRevision === nextMsg.privacyRevision &&
    prevMsg.error === nextMsg.error &&
    prevMsg.unfinished === nextMsg.unfinished &&
    /** Read by the row: `useGenerationsByLatest` gates the Continue button on it and
     *  `ContentRender` renders the tool-call-limit notice from it. */
    prevMsg.finish_reason === nextMsg.finish_reason &&
    prevMsg.createdAt === nextMsg.createdAt &&
    prevMsg.depth === nextMsg.depth &&
    prevMsg.isCreatedByUser === nextMsg.isCreatedByUser &&
    prevMsg.isUserSubmitted === nextMsg.isUserSubmitted &&
    (prevMsg.children?.length ?? 0) === (nextMsg.children?.length ?? 0) &&
    prevMsg.content === nextMsg.content &&
    prevMsg.model === nextMsg.model &&
    prevMsg.endpoint === nextMsg.endpoint &&
    prevMsg.iconURL === nextMsg.iconURL &&
    prevMsg.feedback?.rating === nextMsg.feedback?.rating &&
    areMessageFilesEqual(prevMsg.files, nextMsg.files) &&
    (prevMsg.attachments?.length ?? 0) === (nextMsg.attachments?.length ?? 0) &&
    (prevMsg.manualSkills?.length ?? 0) === (nextMsg.manualSkills?.length ?? 0) &&
    (prevMsg.alwaysAppliedSkills?.length ?? 0) === (nextMsg.alwaysAppliedSkills?.length ?? 0) &&
    (prevMsg.quotes?.length ?? 0) === (nextMsg.quotes?.length ?? 0)
  );
}

type TailRelationProps = {
  message?: TMessage | null;
  latestMessageId?: string;
  latestMessageDepth?: number;
};

/**
 * True when moving the thread's tail leaves a row's rendering unchanged. Rows read
 * `latestMessageId` and `latestMessageDepth` only by comparing them to their own id
 * and depth, and for whether a tail is known at all, so a submission or a server id
 * hydration re-renders just the rows entering or leaving the tail.
 */
export function isSameTailRelation(prev: TailRelationProps, next: TailRelationProps): boolean {
  return (
    (prev.latestMessageId == null) === (next.latestMessageId == null) &&
    (prev.latestMessageId === prev.message?.messageId) ===
      (next.latestMessageId === next.message?.messageId) &&
    (prev.latestMessageDepth === prev.message?.depth) ===
      (next.latestMessageDepth === next.message?.depth)
  );
}

/**
 * Comparator for the memoized message-row wrappers (Message / MessageContent /
 * MessageParts): identity-compare the scalar props, field-compare the message.
 * The child recursion lives in MultiMessage, so a bailed row never severs the
 * spine walk that delivers streaming updates to descendants.
 */
export function areMessageRowPropsEqual(prev: TMessageProps, next: TMessageProps): boolean {
  return (
    prev.currentEditId === next.currentEditId &&
    prev.setCurrentEditId === next.setCurrentEditId &&
    prev.siblingIdx === next.siblingIdx &&
    prev.siblingCount === next.siblingCount &&
    prev.setSiblingIdx === next.setSiblingIdx &&
    prev.isSearchView === next.isSearchView &&
    prev.conversation === next.conversation &&
    areMessageFieldsEqual(prev.message, next.message)
  );
}
