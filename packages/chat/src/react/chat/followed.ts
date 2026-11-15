import { useMemo, useState, useCallback } from 'react';
import { useSetAtom } from 'jotai';
import type { TMessage, TAttachment, TConversation } from 'librechat-data-provider';
import type { ChatContract } from './contract';
import type { FollowedChat } from '../follow';
import { useBranchTailId, useBranchTailSelect } from '../latest';
import { siblingIdxFamily, siblingKey } from '../thread';
import { getMappingOptions } from '../../core';

export type FollowedContractOptions = {
  /** The conversation followed, which keys its messages in the cache. */
  id: string;
  followed: FollowedChat;
  /**
   * The pane number a host keys its per-pane state by. Never one a driven chat renders into, or
   * the two would share that state.
   */
  index: number;
  /** What the rows read of the conversation: its id, endpoint and agent. */
  conversation: TConversation | null;
};

const ignore = (): void => undefined;
const stopped = (): Promise<void> => Promise.resolve();
const noFiles: ChatContract['files'] = new Map();
const noOptions: ChatContract['optionSettings'] = {};
const noAttachments: Record<string, TAttachment[] | undefined> = {};
const useNoLiveAttachments = (): Record<string, TAttachment[] | undefined> => noAttachments;

/** Where the tail sits in its thread, which a streamed delta does not change. */
const pickTailPlace = (tail: TMessage | null): Pick<TMessage, 'depth' | 'parentMessageId'> | null =>
  tail && { depth: tail.depth, parentMessageId: tail.parentMessageId };

/**
 * The chat contract the message rows read, over a conversation that is followed rather than
 * driven. Reading is real: the list, its revisions, the tail of the branch on screen, whether a
 * generation is running. Everything that would take a turn (send, regenerate, continue, stop,
 * files, a new conversation) does nothing, because the reader does not drive this conversation.
 */
export function useFollowedContract({
  id,
  followed,
  index,
  conversation,
}: FollowedContractOptions): ChatContract {
  const { chat, status } = followed;
  const [abortScroll, setAbortScroll] = useState(false);
  const tailPlace = useBranchTailSelect(id, id, pickTailPlace);
  const latestMessageId = useBranchTailId(id, id) ?? undefined;
  const latestMessageDepth = tailPlace?.depth;
  const setSiblingIdx = useSetAtom(siblingIdxFamily(siblingKey(tailPlace?.parentMessageId)));
  const isSubmitting = status === 'submitted' || status === 'streaming';

  const getMessages = useCallback(
    (targetConversationId?: string | null) =>
      targetConversationId == null || targetConversationId === id ? chat?.messages : undefined,
    [chat, id],
  );
  const setMessages = useCallback(
    (messages: TMessage[]) => void chat?.setMessages(messages),
    [chat],
  );
  const subscribeMessages = useCallback(
    (onChange: () => void) => chat?.subscribe(onChange) ?? ignore,
    [chat],
  );
  const getMessagesRevision = useCallback(() => chat?.version ?? 0, [chat]);

  return useMemo<ChatContract>(
    () => ({
      index,
      conversation,
      setConversation: ignore,
      newConversation: ignore,
      preset: null,
      setPreset: ignore,
      optionSettings: noOptions,
      setOptionSettings: ignore,
      getMessages,
      messagesKey: id,
      setMessages,
      subscribeMessages,
      getMessagesRevision,
      setSiblingIdx,
      latestMessageId,
      latestMessageDepth,
      useLiveAttachments: useNoLiveAttachments,
      ask: ignore,
      regenerate: ignore,
      isSubmitting,
      setIsSubmitting: ignore,
      handleRegenerate: ignore,
      handleContinue: ignore,
      stopGenerating: stopped,
      handleStopGenerating: ignore,
      abortScroll,
      setAbortScroll,
      files: noFiles,
      setFiles: ignore,
      filesLoading: false,
      setFilesLoading: ignore,
      feedbackEnabled: false,
      getMappingOptions,
    }),
    [
      id,
      index,
      conversation,
      getMessages,
      setMessages,
      subscribeMessages,
      getMessagesRevision,
      setSiblingIdx,
      latestMessageId,
      latestMessageDepth,
      isSubmitting,
      abortScroll,
    ],
  );
}
