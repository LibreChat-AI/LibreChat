import { useMemo, useState, useCallback } from 'react';
import { useSetAtom } from 'jotai';
import { useQueryClient } from '@tanstack/react-query';
import { getStreamStartFailureText } from '@librechat/chat';
import { showStopButtonByIndex } from '@librechat/chat/react';
import type { ResumableRun, ResumableEvents, ResumableUsage } from '@librechat/chat';
import type { EventSubmission } from 'librechat-data-provider';
import type { EventHandlerParams } from './useEventHandlers';
import type { TResData, TFinalResData } from '~/common';
import { countTrailingOutputChars, markStreamStartFailedMetadata } from '~/utils';
import { reopenTermsOnRefusal } from '~/utils/terms';
import useEventHandlers from './useEventHandlers';
import useUsageHandler from './useUsageHandler';
import useLocalize from '~/hooks/useLocalize';

const getStreamStartFailureData = (errorData?: unknown, termsRefusalText?: string): TResData =>
  ({
    text: termsRefusalText ?? getStreamStartFailureText(errorData),
    metadata: markStreamStartFailedMetadata(),
  }) as unknown as TResData;

/**
 * The handlers that render a resumable stream into the pane (step, final, created, content,
 * title and attachment events, the error cards) and the usage tracking it feeds.
 */
export default function useResumableEvents({
  run,
  runIndex,
  isAddedRequest,
  chatHelpers,
}: {
  run: ResumableRun;
  runIndex: number;
  isAddedRequest: boolean;
  chatHelpers: Pick<
    EventHandlerParams,
    'setMessages' | 'getMessages' | 'setConversation' | 'setIsSubmitting' | 'newConversation'
  >;
}): { events: ResumableEvents; usage: ResumableUsage } {
  const localize = useLocalize();
  const queryClient = useQueryClient();
  const [_completed, setCompleted] = useState(new Set());
  const setShowStopButton = useSetAtom(showStopButtonByIndex(runIndex));
  const { setMessages, getMessages, setConversation, setIsSubmitting, newConversation } =
    chatHelpers;

  const {
    stepHandler: rawStepHandler,
    finalHandler,
    errorHandler,
    clearStepMaps,
    messageHandler,
    contentHandler,
    createdHandler,
    titleHandler,
    syncStepMessage,
    prunePtcTraces,
    attachmentHandler,
    resetContentHandler,
    flushPendingDeltas,
  } = useEventHandlers({
    setMessages,
    getMessages,
    setCompleted,
    isAddedRequest,
    runIndex,
    setConversation,
    setIsSubmitting,
    newConversation,
    setShowStopButton,
  });

  /**
   * Run steps and activity labels must resolve indices in ONE space, and the
   * resume SYNC boundary that invalidates the edit prefix is owned here, so
   * this transport stamps its cleared state onto every dispatched
   * submission. `useStepHandler` reads the flag (alongside the captured
   * `editPrefixLength`) instead of measuring the live
   * `initialResponse.content`, which SYNC replaces with the server's
   * completion-local snapshot.
   *
   * Only allocates once the prefix is actually cleared; before that, and on
   * the non-resumable transport, the submission passes through untouched.
   */
  const stepHandler = useCallback(
    (...[event, submission]: Parameters<typeof rawStepHandler>) => {
      const eventSubmission = run.editPrefixCleared
        ? ({ ...submission, editPrefixCleared: true } as EventSubmission)
        : submission;
      rawStepHandler(event, eventSubmission);
      if (eventSubmission.editPrefixFirstPartFolded === true) {
        run.editPrefixFirstPartFolded = true;
      }
    },
    [rawStepHandler, run],
  );

  const {
    bindResponse,
    contextHandler,
    usageHandler,
    tapStream,
    tapContent,
    finalizeUsage,
    backfillUsage,
    resetLive,
    seedLive,
  } = useUsageHandler();

  const events = useMemo<ResumableEvents>(
    () => ({
      stepHandler,
      showStartFailure: (failedSubmission, errorData, reason) => {
        let text: string | undefined;
        if (reason === 'recovery_held') {
          text = localize('com_ui_steer_recovery_held');
        } else if (reopenTermsOnRefusal(queryClient, errorData)) {
          text = localize('com_error_terms_not_accepted');
        }
        errorHandler({
          data: getStreamStartFailureData(errorData, text),
          submission: failedSubmission as EventSubmission,
        });
      },
      finalHandler: (data, finalSubmission) => finalHandler(data as TFinalResData, finalSubmission),
      createdHandler,
      attachmentHandler,
      titleHandler,
      contentHandler,
      messageHandler,
      prunePtcTraces,
      resetContentHandler,
      syncStepMessage,
      clearStepMaps,
      flushPendingDeltas,
      resetLive,
      showError: (text, errorSubmission) =>
        errorHandler({
          data: { text } as unknown as Parameters<typeof errorHandler>[0]['data'],
          submission: errorSubmission as EventSubmission,
        }),
    }),
    [
      localize,
      queryClient,
      stepHandler,
      finalHandler,
      errorHandler,
      createdHandler,
      attachmentHandler,
      titleHandler,
      contentHandler,
      messageHandler,
      prunePtcTraces,
      resetContentHandler,
      syncStepMessage,
      clearStepMaps,
      flushPendingDeltas,
      resetLive,
    ],
  );

  const usage = useMemo<ResumableUsage>(
    () => ({
      bindResponse,
      contextHandler,
      usageHandler,
      tapStream,
      tapContent,
      finalizeUsage,
      backfillUsage,
      seedLiveFromContent: (content, usageSubmission) =>
        seedLive(countTrailingOutputChars(content), usageSubmission),
    }),
    [
      bindResponse,
      contextHandler,
      usageHandler,
      tapStream,
      tapContent,
      finalizeUsage,
      backfillUsage,
      seedLive,
    ],
  );

  return { events, usage };
}
