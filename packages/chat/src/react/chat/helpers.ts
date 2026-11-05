import { useCallback, useMemo, useRef, useState } from 'react';
import { useAtom, useSetAtom } from 'jotai';
import type { TMessage } from 'librechat-data-provider';
import type { MouseEvent } from 'react';
import type { ChatContract } from './contract';
import { isSubmittingFamily, submissionByIndex, useIsSubmitting } from '../submission';
import { presetFamily, filesFamily, optionSettingsFamily } from '../pane';
import { useLiveAttachments } from '../stream/atoms';
import { abortScrollFamily } from '../generation';
import { getMessageCacheIds } from './cache';
import { useStopGenerating } from './stop';
import { useChatHost } from './host';
import { useTurns } from './turns';

/**
 * Builds a pane's chat contract from the app the host supplies: its pane store, message cache,
 * turn builder and transport. `paramId` is the route's conversation id, which keys the messages
 * the contract reads ahead of the pane's conversation while navigation settles.
 */
export default function useChatHelpers(index = 0, paramId?: string): ChatContract {
  const host = useChatHost();
  const [files, setFiles] = useAtom(filesFamily(index));
  const [filesLoading, setFilesLoading] = useState(false);

  const cache = host.useMessageCache();
  const newConversation = host.useNewConversation(index);
  const { conversation, setConversation } = host.usePaneConversation(index);
  const conversationId = conversation?.conversationId;

  /** Use paramId (from URL) as primary source for query key - this must match what ChatView uses
  Falling back to conversationId (Recoil) only if paramId is not available */
  const queryParam = paramId === 'new' ? paramId : (paramId ?? conversationId ?? '');

  const isSubmitting = useIsSubmitting(index);
  const setIsSubmitting = useSetAtom(isSubmittingFamily(index));
  const latestMessage = host.useLatestMessage(index, queryParam);

  const latestMessageId = host.useLatestMessageId(index, queryParam) ?? undefined;
  const latestMessageDepth = latestMessage?.depth;
  const latestMessageRef = useRef(latestMessage);
  latestMessageRef.current = latestMessage;

  const setSiblingIdx = host.useSetSiblingIdx(latestMessage?.parentMessageId ?? null);
  /** The setter is rebound whenever the tail's parent changes (every turn); the
   *  ref keeps `handleContinue` referentially stable so rows do not re-render. */
  const setSiblingIdxRef = useRef(setSiblingIdx);
  setSiblingIdxRef.current = setSiblingIdx;

  const setMessages = useCallback(
    (messages: TMessage[]) => {
      const messageCacheIds = getMessageCacheIds({ queryParam, conversationId, messages });
      for (const messageCacheId of messageCacheIds) {
        cache.write(messageCacheId, messages);
      }
    },
    [queryParam, cache, conversationId],
  );

  const subscribeMessages = useCallback(
    (onChange: () => void) => cache.subscribe(queryParam, onChange),
    [cache, queryParam],
  );
  const getMessagesRevision = useCallback(() => cache.revision(queryParam), [cache, queryParam]);

  const getMessages = useCallback(
    (targetConversationId?: string | null) => cache.read(targetConversationId ?? queryParam),
    [queryParam, cache],
  );

  const setSubmission = useSetAtom(submissionByIndex(index));

  const turnsParams = {
    index,
    files,
    setFiles,
    getMessages,
    setMessages,
    isSubmitting,
    conversation,
    latestMessage,
    setSubmission,
    setConversation,
  };
  const { ask: _ask, regenerate: _regenerate } = useTurns(
    turnsParams,
    host.useTurnServices(turnsParams),
  );

  const askRef = useRef(_ask);
  askRef.current = _ask;
  const ask: typeof _ask = useCallback((...args) => askRef.current(...args), []);

  const regenerateRef = useRef(_regenerate);
  regenerateRef.current = _regenerate;
  const regenerate: typeof _regenerate = useCallback(
    (...args) => regenerateRef.current(...args),
    [],
  );

  const continueGeneration = useCallback(() => {
    const currentLatest = latestMessageRef.current;
    if (!currentLatest) {
      console.error('Failed to regenerate the message: latestMessage not found.');
      return;
    }

    const messages = getMessages();

    const parentMessage = messages?.find(
      (element) => element.messageId == currentLatest.parentMessageId,
    );

    if (parentMessage && parentMessage.isCreatedByUser) {
      ask(
        { ...parentMessage },
        {
          isContinued: true,
          isRegenerate: true,
          isEdited: true,
          overrideManualSkills: parentMessage.manualSkills,
          overrideQuotes: parentMessage.quotes,
          overrideReasoning: parentMessage.reasoningOverride ?? null,
        },
      );
    } else {
      console.error(
        'Failed to regenerate the message: parentMessage not found, or not created by user.',
      );
    }
  }, [getMessages, ask]);

  const stopGenerating = useStopGenerating(index, conversation);

  const handleStopGenerating = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      e.preventDefault();
      stopGenerating();
    },
    [stopGenerating],
  );

  const handleRegenerate = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      e.preventDefault();
      const parentMessageId = latestMessageRef.current?.parentMessageId ?? '';
      if (!parentMessageId) {
        console.error('Failed to regenerate the message: parentMessageId not found.');
        return;
      }
      regenerate({ parentMessageId });
    },
    [regenerate],
  );

  const handleContinue = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      e.preventDefault();
      continueGeneration();
      setSiblingIdxRef.current(0);
    },
    [continueGeneration],
  );

  const [preset, setPreset] = useAtom(presetFamily(index));
  const [abortScroll, setAbortScroll] = useAtom(abortScrollFamily(index));
  const [optionSettings, setOptionSettings] = useAtom(optionSettingsFamily(index));

  /** Read once per chat rather than per message row: message rows never unmount, so a
   *  per-row settings read would accumulate for the length of the conversation. */
  const feedbackEnabled = host.useFeedbackEnabled();
  const { getMappingOptions } = host;

  return useMemo(
    (): ChatContract => ({
      newConversation,
      conversation,
      setConversation,
      isSubmitting,
      setIsSubmitting,
      getMessages,
      messagesKey: queryParam,
      setMessages,
      subscribeMessages,
      getMessagesRevision,
      setSiblingIdx,
      latestMessageId,
      latestMessageDepth,
      useLiveAttachments,
      ask,
      index,
      regenerate,
      stopGenerating,
      handleStopGenerating,
      handleRegenerate,
      handleContinue,
      abortScroll,
      setAbortScroll,
      preset,
      setPreset,
      optionSettings,
      setOptionSettings,
      files,
      setFiles,
      filesLoading,
      setFilesLoading,
      feedbackEnabled,
      getMappingOptions,
    }),
    [
      newConversation,
      conversation,
      setConversation,
      isSubmitting,
      setIsSubmitting,
      getMessages,
      queryParam,
      setMessages,
      subscribeMessages,
      getMessagesRevision,
      setSiblingIdx,
      latestMessageId,
      latestMessageDepth,
      ask,
      index,
      regenerate,
      stopGenerating,
      handleStopGenerating,
      handleRegenerate,
      handleContinue,
      abortScroll,
      setAbortScroll,
      preset,
      setPreset,
      optionSettings,
      setOptionSettings,
      files,
      setFiles,
      filesLoading,
      setFilesLoading,
      feedbackEnabled,
      getMappingOptions,
    ],
  );
}
