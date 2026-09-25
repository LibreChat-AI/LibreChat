import { memo, useRef, useMemo, useEffect, useState, useCallback } from 'react';
import { useWatch } from 'react-hook-form';
import { useRecoilState, useRecoilValue } from 'recoil';
import { Constants, isAssistantsEndpoint, isAgentsEndpoint } from 'librechat-data-provider';
import { composerSurfaceClasses, composerSurfaceShadow, TextareaAutosize } from '@librechat/client';
import type { TChatProject, TMessage, TConversation } from 'librechat-data-provider';
import type { SetterOrUpdater } from 'recoil';
import type { ExtendedFile, FileSetter, ConvoGenerator, TAskFunction } from '~/common';
import type { QueuedMessageContext } from '~/hooks/Chat/useSteering';
import {
  useTextarea,
  useAutoSave,
  useLocalize,
  useRequiresKey,
  useHandleKeyUp,
  useQueryParams,
  useSubmitMessage,
  useFocusChatEffect,
  useCodeWorkspace,
} from '~/hooks';
import {
  useChatContext,
  useChatFormContext,
  useAddedChatContext,
  useAssistantsMapContext,
  useComposerRestoreHost,
  BadgeRowProvider,
} from '~/Providers';
import {
  cn,
  getModelSpec,
  hasIncompleteFiles,
  removeFocusRings,
  getComposerDraftId,
  getFilesDraftCached,
  isPastedTextFileMarked,
} from '~/utils';
import {
  PendingToolApprovalButton,
  PendingToolApprovalPanel,
} from '~/components/Chat/approval/Review';
import useComposerRestore from '~/hooks/Input/useComposerRestore';
import usePastedTextEdit from '~/hooks/Files/usePastedTextEdit';
import useAskAnswerMode from '~/hooks/Input/useAskAnswerMode';
import AskUserQuestionPopover from './AskUserQuestionPopover';
import useComposerItems from '~/hooks/Input/useComposerItems';
import useAttachTarget from '~/hooks/Input/useAttachTarget';
import InterruptSteerButton from './InterruptSteerButton';
import Hints, { composerHintId } from './Composer/Hints';
import PastedTextDialog from './Files/PastedTextDialog';
import DuringRunSendButton from './DuringRunSendButton';
import ProjectLandingChip from '../ProjectLandingChip';
import useDictation from '~/hooks/Input/useDictation';
import { useGetStartupConfig } from '~/data-provider';
import CodeWorkspaceMenu from './CodeWorkspaceMenu';
import useSteering from '~/hooks/Chat/useSteering';
import CodeApprovalMenu from './CodeApprovalMenu';
import TextareaHeader from './TextareaHeader';
import PromptsCommand from './PromptsCommand';
import { submitFromComposer } from './submit';
import SkillsCommand from './SkillsCommand';
import AutoPlayAudio from './AutoPlayAudio';
import Waveform from './Composer/Waveform';
import { mainTextareaId } from '~/common';
import CollapseChat from './CollapseChat';
import QuoteButton from './QuoteButton';
import ToolDialogs from './ToolDialogs';
import StopButton from './StopButton';
import SendButton from './SendButton';
import Queue from './Composer/Queue';
import Tray from './Composer/Tray';
import Bar from './Composer/Bar';
import Mention from './Mention';
import store from '~/store';

export function toRestoredComposerFile(
  file: NonNullable<TMessage['files']>[number],
): ExtendedFile | null {
  if (!file.file_id) {
    return null;
  }
  return {
    file_id: file.file_id,
    filename: file.filename,
    filepath: file.filepath,
    type: file.type ?? '',
    height: file.height,
    width: file.width,
    size: file.bytes ?? 0,
    progress: 1,
    attached: true,
    llmDeliveryPath: file.llmDeliveryPath,
  };
}

interface ChatFormProps {
  index: number;
  placeholder?: string;
  project?: TChatProject;
  /** Owned by ChatView: which layout the composer sits in — the welcome screen
   *  floats or bottoms it out, a conversation ends the page with it. */
  isLandingPage: boolean;
  /** Owned by the host: the persisted preference for showing keyboard hints. */
  showComposerTips: boolean;
  /** Owned by the host: the persisted preference for whether Enter sends the
   *  message (vs. queues a newline). The composer only consumes it. */
  enterToSend: boolean;
  /** Owned by the host: the Auto Send Text preference dictation consumes. */
  autoSendText: number;
  /** Owned by the host: whether the shell has loaded the speech settings yet;
   *  dictation stays off until it has. */
  speechSettingsInitialized: boolean;
  /** Owned by the host: the app-level preference for where the welcome-screen
   *  composer sits. The chat feature only consumes it. */
  centerFormOnLanding: boolean;
  /** Owned by ChatView: whether a footer bar renders under this band. It is an
   *  absolutely positioned bar in a zero-height wrapper, so the clearance here
   *  is the only thing keeping it off the composer. True on the welcome screen,
   *  which always carries one, and in a conversation whose deployment
   *  configured footer content of its own. */
  footerBelow: boolean;
  /** From ChatContext: individual values so memo can compare them */
  files: Map<string, ExtendedFile>;
  setFiles: FileSetter;
  conversation: TConversation | null;
  setConversation: SetterOrUpdater<TConversation | null>;
  isSubmitting: boolean;
  setFilesLoading: React.Dispatch<React.SetStateAction<boolean>>;
  newConversation: ConvoGenerator;
  handleStopGenerating: (e: React.MouseEvent<HTMLButtonElement>) => void;
  stopGenerating: () => void;
}

/** Targets that own focus themselves: form fields and links, popup disclosures
 * (Ariakit and Radix both emit `aria-haspopup`), and popup content, which React
 * bubbles through portals. */
const focusOwningTargetSelector = [
  'a',
  'input',
  'select',
  'textarea',
  'label',
  '[aria-haspopup]:not([aria-haspopup="false"])',
  '[role="combobox"]',
  '[role="menu"]',
  '[role="listbox"]',
  '[role="dialog"]',
  '[role="alertdialog"]',
].join(', ');

const ChatForm = memo(function ChatForm({
  index,
  placeholder,
  project,
  isLandingPage,
  showComposerTips,
  enterToSend,
  autoSendText,
  speechSettingsInitialized,
  footerBelow,
  centerFormOnLanding,
  files,
  setFiles,
  conversation,
  setConversation,
  isSubmitting,
  setFilesLoading,
  newConversation,
  handleStopGenerating,
  stopGenerating,
}: ChatFormProps) {
  const submitButtonRef = useRef<HTMLButtonElement>(null);
  const textAreaRef = useRef<HTMLTextAreaElement>(null);
  /** The palette anchors to the whole composer, not to its own button, so it
   *  spans the composer width and sits flush above it. */
  const composerBoxRef = useRef<HTMLDivElement>(null);
  useFocusChatEffect(textAreaRef);
  const localize = useLocalize();

  const [isCollapsed, setIsCollapsed] = useState(false);
  const [, setIsScrollable] = useState(false);
  const [visualRowCount, setVisualRowCount] = useState(1);
  const [isTextAreaFocused, setIsTextAreaFocused] = useState(false);
  /** Last measured row count, so an unchanged measurement never schedules a
   *  render at all rather than relying on a state-equality bailout. */
  const measuredRowCountRef = useRef(1);

  const SpeechToText = useRecoilValue(store.speechToText);
  const TextToSpeech = useRecoilValue(store.textToSpeech);
  const chatDirection = useRecoilValue(store.chatDirection);
  const automaticPlayback = useRecoilValue(store.automaticPlayback);
  const maximizeChatSpace = useRecoilValue(store.maximizeChatSpace);
  const isTemporary = useRecoilValue(store.isTemporary);

  const [showStopButton, setShowStopButton] = useRecoilState(store.showStopButtonByIndex(index));
  const plusPopoverAtom = useMemo(() => store.showPlusPopoverFamily(index), [index]);
  const mentionPopoverAtom = useMemo(() => store.showMentionPopoverFamily(index), [index]);

  const { requiresKey } = useRequiresKey();
  const methods = useChatFormContext();
  const {
    generateConversation,
    conversation: addedConvo,
    setConversation: setAddedConvo,
  } = useAddedChatContext();
  const assistantMap = useAssistantsMapContext();
  const { data: startupConfig } = useGetStartupConfig();

  const endpoint = useMemo(
    () => conversation?.endpointType ?? conversation?.endpoint,
    [conversation?.endpointType, conversation?.endpoint],
  );
  const modelSpec = useMemo(
    () => getModelSpec({ specName: conversation?.spec, startupConfig }),
    [conversation?.spec, startupConfig],
  );
  const filesLoading = useMemo(() => hasIncompleteFiles(files), [files]);
  /** Agents and assistants carry their own tool configuration, so the composer's
   *  ephemeral tool controls only apply elsewhere, and a spec can suppress them
   *  outright. Same gate the old `showEphemeralBadges` prop applied. */
  const showTools = useMemo(
    () =>
      !!endpoint &&
      modelSpec?.hideBadgeRow !== true &&
      !isAgentsEndpoint(endpoint) &&
      !isAssistantsEndpoint(endpoint),
    [endpoint, modelSpec?.hideBadgeRow],
  );
  const conversationId = useMemo(
    () => conversation?.conversationId ?? Constants.NEW_CONVO,
    [conversation?.conversationId],
  );
  /**
   * The quote feature merges excerpts server-side in `BaseClient.sendMessage`,
   * which the Assistants endpoints bypass, so hide the UI there rather than
   * letting users queue quotes the assistant never receives.
   */
  const quotesEnabled = useMemo(() => !isAssistantsEndpoint(endpoint), [endpoint]);

  const isRTL = useMemo(
    () => (chatDirection != null ? chatDirection?.toLowerCase() === 'rtl' : false),
    [chatDirection],
  );
  const invalidAssistant = useMemo(
    () =>
      isAssistantsEndpoint(endpoint) &&
      (!(conversation?.assistant_id ?? '') ||
        !assistantMap?.[endpoint ?? '']?.[conversation?.assistant_id ?? '']),
    [conversation?.assistant_id, endpoint, assistantMap],
  );
  const disableInputs = useMemo(
    () => requiresKey || invalidAssistant,
    [requiresKey, invalidAssistant],
  );

  /** Skipped on touchscreens so a tap does not raise the keyboard. */
  const focusTextArea = useCallback(() => {
    if (window.matchMedia?.('(pointer: coarse)').matches) {
      return;
    }
    textAreaRef.current?.focus();
  }, []);

  /** The surface returns focus to the textarea after any click (send, stop, badge
   * toggles), except when the target owns focus itself or opens a popup. Ariakit
   * records `document.activeElement` at open time as a menu's disclosure, so
   * refocusing the textarea behind a menu button made the textarea the disclosure
   * and the menu could never close on textarea interaction (#15624). */
  const handleContainerClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const owner =
        event.target instanceof Element ? event.target.closest(focusOwningTargetSelector) : null;
      if (owner && !owner.contains(event.currentTarget)) {
        return;
      }
      focusTextArea();
    },
    [focusTextArea],
  );

  /** Actions that consume the composer from inside a popup (the during-run
   * hovercard) sit in exempted popup content, so they restore focus themselves. */
  const consumeComposer = useCallback(() => {
    methods.reset();
    focusTextArea();
  }, [methods, focusTextArea]);

  const handleFocusOrClick = useCallback(() => {
    if (isCollapsed) {
      setIsCollapsed(false);
    }
  }, [isCollapsed]);

  const handleTextareaFocus = useCallback(() => {
    handleFocusOrClick();
    setIsTextAreaFocused(true);
  }, [handleFocusOrClick]);

  const handleTextareaBlur = useCallback(() => {
    setIsTextAreaFocused(false);
  }, []);

  const answerMode = useAskAnswerMode(conversationId);
  const answerPlaceholder = answerMode.batchMode
    ? localize('com_ui_answer_questions_above')
    : (answerMode.otherLabel ?? localize('com_ui_something_else'));
  /** The composer is not a plain chat composer: it either IS this pause's
   *  answer box, or is locked behind the batch card that owns the answer. A
   *  collapsed batch is neither, it hands the composer back to the thread. */
  const composerReserved = answerMode.composerAnswers || answerMode.composerLocked;

  const consumeDraft = useAutoSave({
    index,
    files,
    setFiles,
    textAreaRef,
    conversationId,
    isSubmitting,
    // While a question pause is live the composer is the answer box: drafts
    // swap to the answer's own key, and the conversation draft is restored
    // when the question resolves.
    draftId: answerMode.draftId,
  });

  const pastedTextEdit = usePastedTextEdit({ index, files, setFiles, textAreaRef });

  /** Provenance, not the filename, decides which chips are pastes: a user can deliberately
   * upload a `pasted-text.txt`. Restored provenance comes from the files draft; marks made
   * this session are read live from the registry, so new pastes need no recompute. */
  const pastedTextFileIds = useMemo(() => {
    const draftId = getComposerDraftId(index, conversationId, isSubmitting);
    const draftIds = getFilesDraftCached(draftId).pastedTextIds ?? [];
    return new Set<string>(draftIds);
  }, [index, conversationId, isSubmitting]);
  const isPastedTextFile = useCallback(
    (file: ExtendedFile) =>
      pastedTextFileIds.has(file.file_id) ||
      (file.temp_file_id != null && pastedTextFileIds.has(file.temp_file_id)) ||
      isPastedTextFileMarked(file.file_id) ||
      isPastedTextFileMarked(file.temp_file_id),
    [pastedTextFileIds],
  );
  /** The chip's actions hide while a replacement upload or inline move is in flight, so the
   * same original cannot be acted on twice. */
  const isPasteActionPending = useCallback(
    (file: ExtendedFile) => pastedTextEdit.isActionPending(file.file_id),
    [pastedTextEdit],
  );

  const { submitMessage, submitPrompt } = useSubmitMessage();
  const codeWorkspace = useCodeWorkspace(conversation, addedConvo);

  /** Queued/steered sends carry their FULL submission context: explicit
   *  (possibly empty) overrides stop `ask` from vacuuming quotes or skill
   *  picks the user has staged in the composer for their NEXT message. */
  const sendNow = useCallback(
    (text: string, overrideFiles?: TMessage['files'], context?: QueuedMessageContext) =>
      submitMessage({
        text,
        overrideFiles,
        overrideQuotes: context?.quotes ?? [],
        overrideManualSkills: context?.manualSkills ?? [],
        overrideReasoning: context?.reasoningOverride ?? null,
        overrideClientRequestId: context?.clientRequestId,
        overrideRecoverySteerId: context?.recoverySteerId,
        overrideExpectedPredecessorCreatedAt: context?.expectedPredecessorCreatedAt,
        overrideQueuedMessageOrigin: context?.queuedMessageOrigin,
      }),
    [submitMessage],
  );
  const { restoreReclaimedSteer, canRestoreToComposer } = useComposerRestore({
    index,
    conversationId,
    methods,
    files,
    setFiles,
    textAreaRef,
    answerModeActive: composerReserved,
  });
  /* Surfaces outside the composer (a steer cancelled from the thread) re-home
     their words through the same guarded restore the queue rail gets as a
     prop. Published while this composer is mounted; a recovery that resolves
     after it has gone finds nothing and falls back to the queue. */
  const { publish: publishComposerRestore, publishRewake } = useComposerRestoreHost();
  useEffect(() => {
    publishComposerRestore(restoreReclaimedSteer);
    return () => publishComposerRestore(null);
  }, [publishComposerRestore, restoreReclaimedSteer]);
  const steering = useSteering({
    consumeDraft,
    index,
    conversationId,
    conversation,
    isSubmitting,
    answerModeActive: composerReserved,
    files,
    setFiles,
    filesLoading,
    sendNow,
    stopGenerating,
  });
  /* A steer retried from the thread can land in the queue after the run it
     belonged to has ended and spent its one-shot drain signal; the thread
     reaches the drain through the same host as the restore above. */
  const { rewakeDrain: steeringRewakeDrain } = steering;
  useEffect(() => {
    publishRewake(steeringRewakeDrain);
    return () => publishRewake(null);
  }, [publishRewake, steeringRewakeDrain]);

  /** ⌘/Ctrl+Enter = the non-default during-run action, ⌥/Alt+Enter =
   *  interrupt & send (discards the answer), ⌘/Ctrl+Shift+Enter = interrupt &
   *  steer (keeps it): all counterparts of Enter's `submitDuringRun`. */
  const handleDuringRunModifier = useCallback(
    (kind: 'other' | 'interrupt' | 'preempt') => {
      const text = methods.getValues('text');
      let consumed = false;
      if (kind === 'interrupt') {
        consumed = steering.interruptAndSend(text);
      } else if (kind === 'preempt') {
        consumed = steering.interruptSteer(text);
      } else if (steering.effectiveAction === 'steer') {
        consumed = steering.queueFromComposer(text);
      } else {
        consumed = steering.steerFromComposer(text);
      }
      if (consumed) {
        methods.reset();
      }
    },
    [methods, steering],
  );

  const handleKeyUp = useHandleKeyUp({
    index,
    textAreaRef,
  });
  const {
    isNotAppendable,
    handlePaste,
    handleKeyDown,
    handleCompositionStart,
    handleCompositionEnd,
  } = useTextarea({
    textAreaRef,
    submitButtonRef,
    setIsScrollable,
    disabled: disableInputs || answerMode.composerLocked,
    // The composer IS the free-form answer box while a question pause is live.
    placeholder: composerReserved ? answerPlaceholder : placeholder,
    // Enter stays live during a run when it can steer/queue instead of send.
    allowSubmitWhileGenerating: steering.duringRunActive || answerMode.composerAnswers,
    onDuringRunModifier: steering.duringRunActive ? handleDuringRunModifier : undefined,
    answerModeActive: answerMode.composerAnswers,
  });

  useQueryParams({ textAreaRef });

  /** Attachments stand in for text only on the normal send path. Answer mode
   *  hands the composer text straight to the paused run, which answers with
   *  values and cannot consume files, so an empty draft must stay unsubmittable
   *  there rather than enabling a button whose submit is silently dropped. */
  const submittableFileCount = composerReserved ? 0 : files.size;

  const { ref, ...registerProps } = methods.register('text', {
    required: submittableFileCount === 0,
    onChange: useCallback(
      (e: React.ChangeEvent<HTMLTextAreaElement>) =>
        methods.setValue('text', e.target.value, { shouldValidate: true }),
      [methods],
    ),
  });

  const textValue = useWatch({ control: methods.control, name: 'text' });

  /** The composer commits once per keystroke for the row count and the send
   *  button; a second commit for a row count that did not move (or that no
   *  layout engine can measure, where `lineHeight` is not a number) doubles the
   *  cost of the app's busiest surface for nothing. */
  useEffect(() => {
    const textarea = textAreaRef.current;
    if (!textarea) {
      return;
    }
    const lineHeight = parseFloat(window.getComputedStyle(textarea).lineHeight);
    if (!(lineHeight > 0)) {
      return;
    }
    const nextRowCount = Math.floor(textarea.scrollHeight / lineHeight);
    if (nextRowCount === measuredRowCountRef.current) {
      return;
    }
    measuredRowCountRef.current = nextRowCount;
    setVisualRowCount(nextRowCount);
  }, [textValue]);

  const isMoreThanThreeRows = visualRowCount > 3;

  const composerItems = useComposerItems(conversationId, quotesEnabled);
  const attachTarget = useAttachTarget(conversation, disableInputs);
  const { submitText: submitAnswerText } = answerMode;
  const dictationAnswerModeActive = answerMode.composerAnswers;
  const speechDisabled =
    !speechSettingsInitialized || disableInputs || isNotAppendable || answerMode.composerLocked;
  /** The same gate `onSubmit` applies: while a question pause is live the
   * composer IS the answer box, so a dictated turn has to answer it rather
   * than start a turn the paused run would drop. */
  const dictationAsk = useCallback<TAskFunction>(
    (props) => {
      if (dictationAnswerModeActive && submitAnswerText(props.text)) {
        return;
      }
      return submitMessage({ text: props.text });
    },
    [dictationAnswerModeActive, submitAnswerText, submitMessage],
  );
  const dictation = useDictation({
    ask: dictationAsk,
    duringRunSubmit: steering.duringRunActive ? steering.submitDuringRun : undefined,
    methods,
    /* Answer mode leaves the run submitting while handing the composer over,
       which is exactly when speech must still reach it: the send button is
       enabled on the same terms. */
    isSubmitting: (isSubmitting && !dictationAnswerModeActive) || answerMode.composerLocked,
    filesLoading,
    /* A dictated question answer is cleared by answer mode only after the
       resume succeeds. A transient failure must leave the transcript intact. */
    deferComposerReset: dictationAnswerModeActive,
    disabled: speechDisabled,
    autoSendText,
    speechToText: SpeechToText,
    index,
  });
  const uploadingCount = useMemo(() => {
    let count = 0;
    for (const file of files.values()) {
      if (file.progress < 1) {
        count++;
      }
    }
    return count;
  }, [files]);

  /* The abort is generation-scoped and inert until the start POST installs the
     epoch; assistants abort through their own path and need no epoch. */
  const canStop = steering.canControlGeneration || isAssistantsEndpoint(endpoint);

  /** One button slot while a run is generating: with composer text the send
   *  button takes over (Enter steers/queues; hover reveals all actions);
   *  clearing the text restores Stop. */
  /* Memoized for `memo(Bar)`: an inline element is a new identity every render,
     and this component re-renders on every keystroke. */
  const duringRunSlot = useMemo(() => {
    const sendOwnsSlot = steering.duringRunActive && (textValue?.trim() ?? '') !== '';
    /* Stays mounted (hidden) behind the during-run send button: the stop
       shortcut resolves against the focused form, so a half-typed steer would
       otherwise leave it reaching into another pane or doing nothing. */
    const stopButton = showStopButton ? (
      <StopButton
        stop={handleStopGenerating}
        setShowStopButton={setShowStopButton}
        canStop={canStop}
        hidden={sendOwnsSlot}
      />
    ) : null;
    if (sendOwnsSlot) {
      return (
        <>
          {steering.canControlGeneration && (
            <InterruptSteerButton
              steering={steering}
              getText={() => methods.getValues('text')}
              onConsumed={consumeComposer}
              disabled={filesLoading}
            />
          )}
          <DuringRunSendButton
            ref={submitButtonRef}
            control={methods.control}
            steering={steering}
            getText={() => methods.getValues('text')}
            onConsumed={consumeComposer}
            disabled={filesLoading}
          />
          {stopButton}
        </>
      );
    }
    return stopButton;
  }, [
    consumeComposer,
    steering,
    textValue,
    methods,
    submitButtonRef,
    filesLoading,
    showStopButton,
    setShowStopButton,
    handleStopGenerating,
    canStop,
  ]);

  /* Memoized for `memo(Bar)`: an inline element is a new identity every render,
     and this component re-renders on every keystroke. */
  /* Gated on the slot having something to show rather than on `showStopButton`:
     that flag only flips once the start POST installs the generation epoch, and
     until then Enter already queues while this slot still offered the ordinary
     send button, disabled. The slot decides for itself between the during-run
     control, Stop, and nothing, so an empty one falls through to send. */
  const actionSlot = useMemo(
    () =>
      isSubmitting && !answerMode.composerAnswers && duringRunSlot != null
        ? duringRunSlot
        : endpoint && (
            <SendButton
              ref={submitButtonRef}
              control={methods.control}
              fileCount={submittableFileCount}
              disabled={
                filesLoading ||
                disableInputs ||
                !codeWorkspace.canSubmit ||
                isNotAppendable ||
                answerMode.composerLocked ||
                (isSubmitting && !answerMode.composerAnswers)
              }
            />
          ),
    [
      codeWorkspace.canSubmit,
      endpoint,
      duringRunSlot,
      filesLoading,
      disableInputs,
      isNotAppendable,
      isSubmitting,
      answerMode.composerAnswers,
      answerMode.composerLocked,
      submittableFileCount,
      methods.control,
    ],
  );

  const baseClasses = useMemo(
    () =>
      cn(
        'md:py-3.5 m-0 w-full resize-none py-[13px] placeholder:text-text-tertiary bg-transparent [&:has(textarea:focus)]:shadow-[0_2px_6px_rgba(0,0,0,.05)]',
        isCollapsed ? 'max-h-[52px]' : 'max-h-[45vh] md:max-h-[55vh]',
        isMoreThanThreeRows ? 'pl-5' : 'px-5',
      ),
    [isCollapsed, isMoreThanThreeRows],
  );

  /* From `sm` up the band leaves room under itself for the disclaimer, which only
     the landing page carries — doubled while the centred landing composer floats,
     and dropped back the moment a submission starts the thread. A started
     conversation has nothing beneath it, so it keeps only enough to clear the
     surface's own shadow. Below `sm` the composer runs to the viewport floor in
     every state. */
  const landingClearance =
    centerFormOnLanding && !isSubmitting ? 'transition-all duration-200 sm:mb-28' : 'sm:mb-10';
  let bottomClearance = 'sm:mb-4';
  if (isLandingPage) {
    bottomClearance = landingClearance;
  } else if (footerBelow) {
    /* A conversation that carries a configured footer keeps the band that bar
       needs, exactly as the welcome screen does. */
    bottomClearance = 'sm:mb-10';
  }

  /** Answer mode, then during-run steering or queueing (a run in flight, or a
   *  queued follow-up about to start), then an ordinary send: the same route
   *  for typed, dictated, and shortcut-bound submissions. */
  const submitComposerText = useCallback(
    (data: { text: string }): false | void =>
      submitFromComposer(
        {
          answerMode,
          steering,
          submitMessage,
          reset: () => methods.reset(),
        },
        data,
      ),
    [answerMode, steering, submitMessage, methods],
  );

  return (
    <form
      onSubmit={methods.handleSubmit((data) => {
        submitComposerText(data);
      })}
      className={cn(
        /* `margin-bottom` is animated as well as `max-width`: it is what carries
           the composer between the landing clearance and the conversation one,
           and the landing page keeps the same form node when a conversation
           opens, so the band travels instead of jumping. The centred landing
           composer overrides both with its own `transition-all`, and a reader who
           asked for less motion gets the new position outright — this one is a
           slide across the page rather than decoration. */
        'mx-auto flex w-full flex-row gap-3 transition-[max-width,margin-bottom] duration-300 motion-reduce:transition-none sm:px-2',
        maximizeChatSpace ? 'max-w-full' : 'md:max-w-3xl xl:max-w-4xl',
        bottomClearance,
      )}
    >
      {/* `min-w-0`: a flex item's automatic minimum size is its content's
          min-content width, and one long unbroken word in a queued message
          propagates all the way up here: the composer stretched past the
          thread and its chips ran off the side. Zeroing it lets the width come
          from the form, so the chips inside truncate instead. */}
      <div className="relative flex h-full min-w-0 flex-1 items-stretch md:flex-col">
        {/* Primary composer owns the selection popup so split-view doesn't double it. */}
        {index === 0 && quotesEnabled && <QuoteButton conversationId={conversationId} />}
        <div className="relative flex w-full flex-col">
          {steering.enabled && (
            <Queue
              steering={steering}
              conversationId={conversationId}
              onRestoreToComposer={restoreReclaimedSteer}
              canRestoreToComposer={canRestoreToComposer}
            />
          )}
          {(project ||
            (codeWorkspace.required && (!codeWorkspace.locked || !codeWorkspace.canSubmit))) && (
            <div
              data-testid="composer-context-rail"
              className={cn(
                'mx-4 -mb-3 flex min-w-0 flex-wrap items-center gap-1 rounded-t-2xl',
                'border-border-light bg-surface-secondary border px-2 pt-1 pb-4',
                isRTL && 'flex-row-reverse',
              )}
            >
              {project ? <ProjectLandingChip project={project} /> : null}
              {codeWorkspace.required && (!codeWorkspace.locked || !codeWorkspace.canSubmit) ? (
                <div className="min-w-0 px-1 pt-1">
                  <CodeWorkspaceMenu
                    setConversation={setConversation}
                    workspace={codeWorkspace}
                    disabled={disableInputs || isSubmitting}
                  />
                </div>
              ) : null}
            </div>
          )}
          <div className={cn('flex w-full items-center', isRTL && 'flex-row-reverse')}>
            <Mention
              index={index}
              popoverAtom={plusPopoverAtom}
              newConversation={generateConversation}
              textAreaRef={textAreaRef}
              commandChar="+"
              placeholder="com_ui_add_model_preset"
              includeAssistants={false}
            />
            <Mention
              index={index}
              popoverAtom={mentionPopoverAtom}
              newConversation={newConversation}
              textAreaRef={textAreaRef}
            />
            <PromptsCommand index={index} textAreaRef={textAreaRef} submitPrompt={submitPrompt} />
            {index === 0 && (
              <AskUserQuestionPopover conversationId={conversationId} textAreaRef={textAreaRef} />
            )}
            {index === 0 && conversationId != null && (
              <PendingToolApprovalPanel conversationId={conversationId} />
            )}
            <SkillsCommand
              index={index}
              textAreaRef={textAreaRef}
              conversationId={conversationId}
              agentId={conversation?.agent_id}
            />
            <div
              ref={composerBoxRef}
              data-testid="composer-surface"
              onClick={handleContainerClick}
              className={cn(
                /* The surface runs to the viewport floor below `sm`, where it is
                   squared off at the bottom (`rounded-t-theme-surface-lg`) and no disclaimer
                   follows it — so the action row is the last thing in it, with no
                   band of padding under the buttons. */
                'rounded-t-theme-surface-lg sm:rounded-theme-surface-lg relative flex w-full grow flex-col overflow-hidden',
                composerSurfaceClasses(),
                isTextAreaFocused ? composerSurfaceShadow.focused : composerSurfaceShadow.blurred,
                /* Temporary-chat accent is a ChatForm-only override, not part of
                   the shared composer-surface decision. Semantic `series-6`, the
                   same categorical slot the purple tool badge uses, so the accent
                   follows the theme instead of the raw `violet-800/60` edge that
                   composited to 1.48:1 on the high contrast dark canvas.
                   Held at half alpha in the standard palettes, where series-6 is
                   a saturated #7e23cd / #ab68fe and a full-strength edge reads as
                   a warning rather than a quiet mode hint. The contrast modes take
                   it opaque, because that is the only way it clears the 3:1
                   non-text floor there. */
                isTemporary && 'border-series-6/50 bg-series-6/10 high-contrast:border-series-6',
              )}
            >
              <TextareaHeader addedConvo={addedConvo} setAddedConvo={setAddedConvo} />
              <Tray
                items={composerItems}
                focusComposer={focusTextArea}
                conversation={conversation}
                files={files}
                setFiles={setFiles}
                setFilesLoading={setFilesLoading}
                isRTL={isRTL}
                index={index}
                isPastedTextFile={isPastedTextFile}
                isPasteActionPending={isPasteActionPending}
                onEditPastedText={pastedTextEdit.openEditor}
                onMovePastedTextInline={pastedTextEdit.moveInline}
              />
              <PastedTextDialog
                edit={pastedTextEdit.editing}
                onClose={pastedTextEdit.closeEditor}
                onSave={pastedTextEdit.saveEdit}
              />
              {endpoint && (
                <div className={cn('flex', isRTL ? 'flex-row-reverse' : 'flex-row')}>
                  <div
                    className="relative flex-1"
                    style={
                      isCollapsed
                        ? {
                            WebkitMaskImage:
                              'linear-gradient(to bottom, black 60%, transparent 90%)',
                            maskImage: 'linear-gradient(to bottom, black 60%, transparent 90%)',
                          }
                        : undefined
                    }
                  >
                    <TextareaAutosize
                      {...registerProps}
                      ref={(e) => {
                        ref(e);
                        (
                          textAreaRef as React.MutableRefObject<HTMLTextAreaElement | null>
                        ).current = e;
                      }}
                      disabled={disableInputs || isNotAppendable || answerMode.composerLocked}
                      onPaste={handlePaste}
                      onKeyDown={(e) => {
                        // Answer mode consumes option-navigation keys from the
                        // empty composer; everything else follows the normal path.
                        if (answerMode.handleComposerKeyDown(e)) {
                          return;
                        }
                        handleKeyDown(e);
                      }}
                      onKeyUp={handleKeyUp}
                      onCompositionStart={handleCompositionStart}
                      onCompositionEnd={handleCompositionEnd}
                      id={mainTextareaId}
                      tabIndex={0}
                      data-testid="text-input"
                      rows={1}
                      onFocus={handleTextareaFocus}
                      onBlur={handleTextareaBlur}
                      aria-label={localize('com_ui_message_input')}
                      aria-describedby={cn(
                        composerHintId(index),
                        (codeWorkspace.state === 'choose' || codeWorkspace.state === 'missing') &&
                          `code-workspace-hint-${index}`,
                      )}
                      onClick={handleFocusOrClick}
                      style={{ height: 44, overflowY: 'auto' }}
                      className={cn(
                        baseClasses,
                        removeFocusRings,
                        'scrollbar-hover transition-[max-height] duration-200 disabled:cursor-not-allowed',
                      )}
                    />
                    {dictation.active && (textValue?.trim() ?? '') === '' && (
                      /* Stands in for the placeholder: same inset, same line, so
                         it reads as the input listening rather than as a widget
                         bolted on. Once words arrive the transcript takes over. */
                      <Waveform
                        active={dictation.active}
                        className={cn(
                          'pointer-events-none absolute inset-y-0 h-full',
                          isMoreThanThreeRows ? 'right-2 left-5' : 'inset-x-5',
                        )}
                      />
                    )}
                    {/* Sits over the fade scrim in the corner of the input
                        rather than in its own column beside it, so a long draft
                        does not push an orphaned control off to the side. */}
                    <div className="absolute right-2 bottom-1 z-10">
                      <CollapseChat
                        isCollapsed={isCollapsed}
                        isScrollable={isMoreThanThreeRows}
                        setIsCollapsed={setIsCollapsed}
                      />
                    </div>
                  </div>
                </div>
              )}
              {(codeWorkspace.state === 'choose' || codeWorkspace.state === 'missing') && (
                <p
                  id={`code-workspace-hint-${index}`}
                  role="status"
                  className="text-text-secondary px-5 pb-2 text-sm"
                >
                  {localize('com_error_code_workspace_required')}
                </p>
              )}
              {/* The composer is what keeps MCP connection and authorization state
                  current wherever its ephemeral tools apply; the Agent Builder's
                  tool library reads the same cache, so without this a server it
                  lists reads as unknown and offers to connect instead of toggling. */}
              <BadgeRowProvider
                conversationId={conversationId}
                specName={conversation?.spec}
                isSubmitting={isSubmitting}
                observeToolAuthorization={showTools}
              >
                <Bar
                  index={index}
                  isRTL={isRTL}
                  disabled={disableInputs}
                  agentId={conversation?.agent_id}
                  /* The RAW endpoint, not the effective type above: the attach
                     destinations resolve the provider from its name, so a
                     custom endpoint reduced to `custom` loses the uploads its
                     provider actually takes (OpenRouter's video and audio).
                     `endpointType` beside it carries the resolved type. */
                  endpoint={conversation?.endpoint}
                  endpointType={attachTarget.endpointType}
                  endpointFileConfig={attachTarget.endpointFileConfig}
                  useResponsesApi={attachTarget.useResponsesApi}
                  conversationId={conversationId}
                  conversation={conversation}
                  files={files}
                  setFiles={setFiles}
                  setFilesLoading={setFilesLoading}
                  canAttach={attachTarget.canAttach}
                  anchorRef={composerBoxRef}
                  showTools={showTools}
                  isSubmitting={isSubmitting}
                  showSpeech={SpeechToText}
                  speechDisabled={speechDisabled}
                  dictation={dictation}
                  approvalSlot={
                    <div className={cn('flex items-center gap-1.5', isRTL && 'flex-row-reverse')}>
                      <CodeApprovalMenu
                        conversation={conversation}
                        addedConversation={addedConvo}
                        setConversation={setConversation}
                        disabled={disableInputs}
                      />
                      {index === 0 && conversationId != null && (
                        <PendingToolApprovalButton conversationId={conversationId} />
                      )}
                    </div>
                  }
                  actionSlot={actionSlot}
                  hasAddedConversation={addedConvo != null}
                />
                <ToolDialogs />
              </BadgeRowProvider>
              {TextToSpeech && automaticPlayback && <AutoPlayAudio index={index} />}
            </div>
          </div>
          {/* Sibling of the composer row, not a child: inside that flex-row it
              would lay out as a narrow column beside the box. */}
          <Hints
            index={index}
            enterToSend={enterToSend}
            showTips={showComposerTips}
            hasText={(textValue?.trim() ?? '') !== ''}
            isSubmitting={isSubmitting}
            duringRunActive={steering.duringRunActive}
            canControlGeneration={steering.canControlGeneration}
            canStop={canStop}
            steerInterruptsByDefault={steering.steerInterruptsByDefault}
            duringRunAction={steering.effectiveAction}
            /* A staged reasoning choice forces the message to queue, and the
               send-now chord then queues too; do not advertise it. */
            canSteer={steering.canSteer && steering.pendingReasoningOverride == null}
            answerModeActive={answerMode.active}
            uploadingCount={uploadingCount}
          />
        </div>
      </div>
    </form>
  );
});
ChatForm.displayName = 'ChatForm';

/**
 * Wrapper that subscribes to ChatContext and passes stable individual values
 * to the memo'd ChatForm. This prevents ChatForm from re-rendering on every
 * streaming chunk: it only re-renders when the specific values it uses change.
 */
function ChatFormWrapper({
  index = 0,
  placeholder,
  project,
  isLandingPage,
  showComposerTips,
  /** Defaults to the atom's own default (`atomWithLocalStorage('enterToSend',
   *  true)`) so call sites that predate this prop, mainly tests, keep their
   *  prior behavior without passing it explicitly. */
  enterToSend = true,
  /** Same reason, from `atomWithLocalStorage('autoSendText', -1)`. */
  autoSendText = -1,
  /** Same reason, from the `speechSettingsInitialized` atom's `false`. */
  speechSettingsInitialized = false,
  footerBelow,
  centerFormOnLanding,
}: {
  index?: number;
  placeholder?: string;
  project?: TChatProject;
  showComposerTips: boolean;
  enterToSend?: boolean;
  autoSendText?: number;
  speechSettingsInitialized?: boolean;
  isLandingPage: boolean;
  footerBelow: boolean;
  centerFormOnLanding: boolean;
}) {
  const {
    files,
    setFiles,
    conversation,
    setConversation,
    isSubmitting,
    setFilesLoading,
    newConversation,
    handleStopGenerating,
    stopGenerating,
  } = useChatContext();

  /**
   * Stabilize conversation reference: only update when rendering-relevant fields change,
   * not on every metadata update (e.g., title generation during streaming).
   */
  const hasMessages = (conversation?.messages?.length ?? 0) > 0;
  const stableConversation = useMemo(
    () => conversation,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      conversation?.conversationId,
      conversation?.endpoint,
      conversation?.endpointType,
      conversation?.agent_id,
      conversation?.assistant_id,
      conversation?.spec,
      conversation?.useResponsesApi,
      conversation?.model,
      conversation?.maxContextTokens,
      conversation?.codeApprovalMode,
      conversation?.codeEnvironmentMode,
      conversation?.codeWorkspaces,
      /** The composer's reasoning control reads its configured value off this
       *  object. Leaving these out held the old level on screen after a
       *  Parameters-panel edit, while the next send already used the new one. */
      conversation?.reasoning_effort,
      conversation?.effort,
      conversation?.thinkingLevel,
      conversation?.thinkingBudget,
      /** The attach picker resolves the upload route from it, and a Responses
       *  routing policy can send web-search turns to a different route. */
      conversation?.web_search,
      hasMessages,
    ],
  );

  /** Stabilize function refs so they never trigger ChatForm re-renders */
  const handleStopRef = useRef(handleStopGenerating);
  handleStopRef.current = handleStopGenerating;
  const stableHandleStop = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => handleStopRef.current(e),
    [],
  );

  const newConvoRef = useRef(newConversation);
  newConvoRef.current = newConversation;
  const stableNewConversation: ConvoGenerator = useCallback(
    (...args: Parameters<ConvoGenerator>): ReturnType<ConvoGenerator> =>
      newConvoRef.current(...args),
    [],
  );

  const stopRef = useRef(stopGenerating);
  stopRef.current = stopGenerating;
  const stableStop = useCallback(() => {
    void stopRef.current();
  }, []);

  return (
    <ChatForm
      index={index}
      showComposerTips={showComposerTips}
      enterToSend={enterToSend}
      autoSendText={autoSendText}
      speechSettingsInitialized={speechSettingsInitialized}
      placeholder={placeholder}
      project={project}
      isLandingPage={isLandingPage}
      footerBelow={footerBelow}
      centerFormOnLanding={centerFormOnLanding}
      files={files}
      setFiles={setFiles}
      conversation={stableConversation}
      setConversation={setConversation}
      isSubmitting={isSubmitting}
      setFilesLoading={setFilesLoading}
      newConversation={stableNewConversation}
      handleStopGenerating={stableHandleStop}
      stopGenerating={stableStop}
    />
  );
}

ChatFormWrapper.displayName = 'ChatFormWrapper';

export default ChatFormWrapper;
