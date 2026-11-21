import { useRef, useMemo, useState, useEffect, useCallback, useLayoutEffect } from 'react';
import { useAtom, useStore, useSetAtom } from 'jotai';
import type { TMessage, TSubmission } from 'librechat-data-provider';
import type { MouseEvent, SetStateAction } from 'react';
import type { ChatTurnsParams, TurnServices } from './host';
import type { ChatContract } from './contract';
import type { FollowedChat } from '../follow';
import { presetFamily, filesFamily, filesOwnerFamily, optionSettingsFamily } from '../pane';
import { useBranchTailId, useBranchTailGetter, useBranchTailSelect } from '../latest';
import { abortScrollFamily, showStopButtonByIndex } from '../generation';
import { siblingIdxFamily, siblingKey } from '../thread';
import { useLiveAttachments } from '../stream/atoms';
import { isSubmittingFamily } from '../submission';
import { getMappingOptions } from '../../core';
import { useTurnHandlers } from './handlers';
import { useChatHost } from './host';
import { useTurns } from './turns';

export type DrivenContractOptions = {
  /** The conversation driven, which keys its messages in the cache. */
  id: string;
  /** The conversation as `useFollowChat` holds it; its `send` is where this chat's turns go. */
  followed: FollowedChat;
  /**
   * The pane the host keys this chat's state by: its conversation, composer files and settings.
   * One no other chat renders into, or the two would share that state.
   */
  index: number;
};

const ignore = (): void => undefined;

/** Where the tail sits in its thread, which a streamed delta does not change. */
const pickTailPlace = (tail: TMessage | null): Pick<TMessage, 'depth' | 'parentMessageId'> | null =>
  tail && { depth: tail.depth, parentMessageId: tail.parentMessageId };

/**
 * The chat contract of a conversation the reader drives through a core `Chat`. It is the
 * contract `useChatHelpers` builds for a pane, from the same host and with the same `ask`, with
 * the three things a pane's stream session owns taken from the `Chat` instead: the messages are
 * the chat's, a turn `ask` built is sent by the chat, and a stop is the chat's.
 *
 * So a turn is refused, built and shown as main chat's is (the composer's files, skills, quotes
 * and reasoning, an edit, a rerun, a continuation), and differs only in what carries it.
 */
export function useDrivenContract({ id, followed, index }: DrivenContractOptions): ChatContract {
  const host = useChatHost();
  const { chat, status, isLoading, isFollowing, canSend, send, stop } = followed;
  const [files, setFiles] = useAtom(filesFamily(index));
  /**
   * The pane's staged files are the conversation's that staged them. The pane outlives the
   * conversation it shows, so when it takes another one the files left in it are dropped: they
   * would otherwise go out with that conversation's next turn. The same conversation drawn
   * again keeps them. In a layout effect, ahead of the composer's own effects, which may put
   * this conversation's saved attachments back.
   */
  const store = useStore();
  useLayoutEffect(() => {
    const owner = filesOwnerFamily(index);
    if (store.get(owner) === id) {
      return;
    }
    store.set(owner, id);
    if (store.get(filesFamily(index)).size > 0) {
      store.set(filesFamily(index), new Map());
    }
  }, [id, index, store]);
  const [filesLoading, setFilesLoading] = useState(false);
  const newConversation = host.useNewConversation(index);
  const { conversation, setConversation } = host.usePaneConversation(index);

  /** A generation started here or anywhere else occupies the conversation alike. */
  const isSubmitting = status === 'submitted' || status === 'streaming' || isFollowing;
  const setIsSubmitting = useSetAtom(isSubmittingFamily(index));
  const setShowStopButton = useSetAtom(showStopButtonByIndex(index));
  /**
   * The pane's own flags, which `ask` raises and the composer reads, follow the chat: nothing
   * else lowers them here, where no stream session runs.
   */
  useEffect(() => {
    setIsSubmitting(isSubmitting);
    setShowStopButton(isSubmitting);
  }, [isSubmitting, setIsSubmitting, setShowStopButton]);

  const tailPlace = useBranchTailSelect(id, id, pickTailPlace);
  const getLatestMessage = useBranchTailGetter(id, id);
  const latestMessageId = useBranchTailId(id, id) ?? undefined;
  const latestMessageDepth = tailPlace?.depth;
  const setSiblingIdx = useSetAtom(siblingIdxFamily(siblingKey(tailPlace?.parentMessageId)));

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

  /**
   * `ask` writes the rows a turn shows and then publishes its submission. Here the chat writes
   * them, so it can take them back, and so the rows are held until the submission they belong
   * to arrives in the same call.
   */
  const shown = useRef<TMessage[]>();
  const holdRows = useCallback((messages: TMessage[]) => {
    shown.current = messages;
  }, []);
  const sendSubmission = useCallback(
    (next: SetStateAction<TSubmission | null>) => {
      const submission = typeof next === 'function' ? next(null) : next;
      const messages = shown.current;
      shown.current = undefined;
      if (submission == null) {
        return;
      }
      if (messages == null || !send({ submission, messages })) {
        /** The chat took nothing, so the flags `ask` raised for the turn come back down. */
        setIsSubmitting(false);
        setShowStopButton(false);
      }
    },
    [send, setIsSubmitting, setShowStopButton],
  );

  const turnsParams: ChatTurnsParams = {
    index,
    files,
    setFiles,
    getMessages,
    setMessages: holdRows,
    isSubmitting: isSubmitting || isLoading,
    conversation,
    getLatestMessage,
    setSubmission: sendSubmission,
    setConversation,
  };
  const appServices = host.useTurnServices(turnsParams);
  /** Asked first, before `ask` drains the composer for a turn the chat would not take. */
  const services: TurnServices = {
    ...appServices,
    canSubmit: (submitted) => canSend() && appServices.canSubmit?.(submitted) !== false,
  };
  const turns = useTurns(turnsParams, services);
  const { ask, regenerate, handleRegenerate, handleContinue } = useTurnHandlers({
    ask: turns.ask,
    regenerate: turns.regenerate,
    getMessages,
    getLatestMessage,
    setSiblingIdx,
  });

  const stopGenerating = stop;
  const handleStopGenerating = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      e.preventDefault();
      void stopGenerating();
    },
    [stopGenerating],
  );

  const [preset, setPreset] = useAtom(presetFamily(index));
  const [abortScroll, setAbortScroll] = useAtom(abortScrollFamily(index));
  const [optionSettings, setOptionSettings] = useAtom(optionSettingsFamily(index));
  const feedbackEnabled = host.useFeedbackEnabled();

  return useMemo<ChatContract>(
    () => ({
      index,
      conversation,
      setConversation,
      newConversation,
      preset,
      setPreset,
      optionSettings,
      setOptionSettings,
      getMessages,
      messagesKey: id,
      setMessages,
      subscribeMessages,
      getMessagesRevision,
      setSiblingIdx,
      latestMessageId,
      latestMessageDepth,
      useLiveAttachments,
      ask,
      regenerate,
      isSubmitting,
      setIsSubmitting,
      handleRegenerate,
      handleContinue,
      stopGenerating,
      stopsUnnamed: true,
      steers: true,
      handleStopGenerating,
      abortScroll,
      setAbortScroll,
      files,
      setFiles,
      filesLoading,
      setFilesLoading,
      feedbackEnabled,
      getMappingOptions,
    }),
    [
      id,
      index,
      conversation,
      setConversation,
      newConversation,
      preset,
      setPreset,
      optionSettings,
      setOptionSettings,
      getMessages,
      setMessages,
      subscribeMessages,
      getMessagesRevision,
      setSiblingIdx,
      latestMessageId,
      latestMessageDepth,
      ask,
      regenerate,
      isSubmitting,
      setIsSubmitting,
      handleRegenerate,
      handleContinue,
      stopGenerating,
      handleStopGenerating,
      abortScroll,
      setAbortScroll,
      files,
      setFiles,
      filesLoading,
      feedbackEnabled,
    ],
  );
}
