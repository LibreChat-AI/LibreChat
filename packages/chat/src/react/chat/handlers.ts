import { useRef, useCallback } from 'react';
import type { MouseEvent } from 'react';
import type { ChatContract } from './contract';
import type { ChatTurnsParams } from './host';

export type TurnHandlersParams = Pick<ChatContract, 'ask' | 'regenerate' | 'setSiblingIdx'> &
  Pick<ChatTurnsParams, 'getMessages' | 'getLatestMessage'>;

export type TurnHandlers = Pick<
  ChatContract,
  'ask' | 'regenerate' | 'handleRegenerate' | 'handleContinue'
>;

/**
 * The turn members of a chat contract over one pane's `ask` and `regenerate`, whichever way the
 * pane's turns reach the server. `ask` and `regenerate` are rebuilt on every render; the ones
 * returned keep one identity and call the latest, so the rows that hold them sit out the stream.
 */
export function useTurnHandlers({
  ask: latestAsk,
  regenerate: latestRegenerate,
  getMessages,
  getLatestMessage,
  setSiblingIdx,
}: TurnHandlersParams): TurnHandlers {
  const askRef = useRef(latestAsk);
  askRef.current = latestAsk;
  const ask: ChatContract['ask'] = useCallback((...args) => askRef.current(...args), []);

  const regenerateRef = useRef(latestRegenerate);
  regenerateRef.current = latestRegenerate;
  const regenerate: ChatContract['regenerate'] = useCallback(
    (...args) => regenerateRef.current(...args),
    [],
  );

  /** The setter is rebound whenever the tail's parent changes (every turn); the
   *  ref keeps `handleContinue` referentially stable so rows do not re-render. */
  const setSiblingIdxRef = useRef(setSiblingIdx);
  setSiblingIdxRef.current = setSiblingIdx;

  const continueGeneration = useCallback(() => {
    const currentLatest = getLatestMessage();
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
  }, [getLatestMessage, getMessages, ask]);

  const handleRegenerate = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      e.preventDefault();
      const parentMessageId = getLatestMessage()?.parentMessageId ?? '';
      if (!parentMessageId) {
        console.error('Failed to regenerate the message: parentMessageId not found.');
        return;
      }
      regenerate({ parentMessageId });
    },
    [getLatestMessage, regenerate],
  );

  const handleContinue = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      e.preventDefault();
      continueGeneration();
      setSiblingIdxRef.current(0);
    },
    [continueGeneration],
  );

  return { ask, regenerate, handleRegenerate, handleContinue };
}
