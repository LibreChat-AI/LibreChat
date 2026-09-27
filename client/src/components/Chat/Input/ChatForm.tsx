import { memo, useRef, useMemo, useEffect, useState, useCallback } from 'react';
import { useWatch } from 'react-hook-form';
import { useRecoilState, useRecoilValue, useRecoilCallback } from 'recoil';
import { Constants, isAssistantsEndpoint, isAgentsEndpoint } from 'librechat-data-provider';
import { composerSurfaceClasses, composerSurfaceShadow, TextareaAutosize } from '@librechat/client';
import type { TChatProject, TMessage, TConversation } from 'librechat-data-provider';
import type { SetterOrUpdater } from 'recoil';
import type { ExtendedFile, FileSetter, ConvoGenerator } from '~/common';
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
  cn,
  getModelSpec,
  hasIncompleteFiles,
  removeFocusRings,
  getComposerDraftId,
  getFilesDraftCached,
  isPastedTextFileMarked,
} from '~/utils';
import {
  useChatContext,
  useChatFormContext,
  useAddedChatContext,
  useAssistantsMapContext,
} from '~/Providers';
import {
  PendingToolApprovalButton,
  PendingToolApprovalPanel,
} from '~/components/Chat/approval/Review';
import PendingManualSkillsChips from './PendingManualSkillsChips';
import usePastedTextEdit from '~/hooks/Files/usePastedTextEdit';
import useAskAnswerMode from '~/hooks/Input/useAskAnswerMode';
import AskUserQuestionPopover from './AskUserQuestionPopover';
import InterruptSteerButton from './InterruptSteerButton';
import PastedTextDialog from './Files/PastedTextDialog';
import DuringRunSendButton from './DuringRunSendButton';
import ProjectLandingChip from '../ProjectLandingChip';
import { useGetStartupConfig } from '~/data-provider';
import { mainTextareaId, BadgeItem } from '~/common';
import PendingSteerChips from './PendingSteerChips';
import PendingQuoteChips from './PendingQuoteChips';
import AttachFileChat from './Files/AttachFileChat';
import CodeWorkspaceMenu from './CodeWorkspaceMenu';
import useSteering from '~/hooks/Chat/useSteering';
import CodeApprovalMenu from './CodeApprovalMenu';
import FileFormChat from './Files/FileFormChat';
import InFlightSteers from './InFlightSteers';
import TextareaHeader from './TextareaHeader';
import PromptsCommand from './PromptsCommand';
import { submitFromComposer } from './submit';
import SkillsCommand from './SkillsCommand';
import AudioRecorder from './AudioRecorder';
import AutoPlayAudio from './AutoPlayAudio';
import CollapseChat from './CollapseChat';
import QuoteButton from './QuoteButton';
import TokenUsage from './TokenUsage';
import StopButton from './StopButton';
import SendButton from './SendButton';
import EditBadges from './EditBadges';
import BadgeRow from './BadgeRow';
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
  useFocusChatEffect(textAreaRef);
  const localize = useLocalize();

  const [isCollapsed, setIsCollapsed] = useState(false);
  const [, setIsScrollable] = useState(false);
  const [visualRowCount, setVisualRowCount] = useState(1);
  const [isTextAreaFocused, setIsTextAreaFocused] = useState(false);
  const [backupBadges, setBackupBadges] = useState<Pick<BadgeItem, 'id'>[]>([]);

  const SpeechToText = useRecoilValue(store.speechToText);
  const TextToSpeech = useRecoilValue(store.textToSpeech);
  const chatDirection = useRecoilValue(store.chatDirection);
  const automaticPlayback = useRecoilValue(store.automaticPlayback);
  const maximizeChatSpace = useRecoilValue(store.maximizeChatSpace);
  const isTemporary = useRecoilValue(store.isTemporary);

  const [badges, setBadges] = useRecoilState(store.chatBadges);
  const [isEditingBadges, setIsEditingBadges] = useRecoilState(store.isEditingBadges);
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
  const hideBadgeRow = modelSpec?.hideBadgeRow === true;
  const filesLoading = useMemo(() => hasIncompleteFiles(files), [files]);
  const conversationId = useMemo(
    () => conversation?.conversationId ?? Constants.NEW_CONVO,
    [conversation?.conversationId],
  );
  /**
   * The quote feature merges excerpts server-side in `BaseClient.sendMessage`,
   * which the Assistants endpoints bypass — so hide the UI there rather than
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
   *  collapsed batch is neither — it hands the composer back to the thread. */
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
        overrideClientRequestId: context?.clientRequestId,
        overrideRecoverySteerId: context?.recoverySteerId,
        overrideExpectedPredecessorCreatedAt: context?.expectedPredecessorCreatedAt,
        overrideQueuedMessageOrigin: context?.queuedMessageOrigin,
      }),
    [submitMessage],
  );
  /** Chip "Edit message" restore: quote chips + skill picks merge back into
   *  their compose-time atoms (the chips above the textarea re-render them). */
  const restoreComposerContext = useRecoilCallback(
    ({ set }) =>
      (context?: QueuedMessageContext) => {
        const { quotes, manualSkills } = context ?? {};
        if (quotes != null && quotes.length > 0) {
          set(store.pendingQuotesByConvoId(conversationId), (prev) => [
            ...new Set([...prev, ...quotes]),
          ]);
        }
        if (manualSkills != null && manualSkills.length > 0) {
          set(store.pendingManualSkillsByConvoId(conversationId), (prev) => [
            ...new Set([...prev, ...manualSkills]),
          ]);
        }
      },
    [conversationId],
  );
  /** Chip "Edit message": the text replaces the composer draft and the chip's
   *  attachments merge back into the composer file map (already uploaded, so
   *  they restore as completed entries — same shape as draft recovery). */
  const editToComposer = useCallback(
    (text: string, chipFiles?: TMessage['files'], context?: QueuedMessageContext) => {
      methods.setValue('text', text, { shouldDirty: true });
      if (chipFiles != null && chipFiles.length > 0) {
        setFiles((prev) => {
          const next = new Map(prev);
          for (const file of chipFiles) {
            const restoredFile = toRestoredComposerFile(file);
            if (restoredFile == null) {
              continue;
            }
            next.set(restoredFile.file_id, restoredFile);
          }
          return next;
        });
      }
      restoreComposerContext(context);
      textAreaRef.current?.focus();
    },
    [methods, setFiles, restoreComposerContext],
  );
  const steering = useSteering({
    consumeDraft,
    addedConversation: addedConvo,
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

  /** Read at call time, not captured: a reclaim resolves into the callback from
   *  the render it was clicked in, so the closure's `conversationId` is the OLD
   *  chat — comparing it against itself would pass while `methods` (one form,
   *  reused across conversations) writes into the chat now on screen. */
  const liveConversationIdRef = useRef(conversationId);
  liveConversationIdRef.current = conversationId;
  /** Same reason: attachments staged after the click must be seen. */
  const liveFilesRef = useRef(files);
  liveFilesRef.current = files;
  /** Same reason: the run can pause on `ask_user_question` mid-reclaim. */
  const liveAnswerModeRef = useRef(composerReserved);
  liveAnswerModeRef.current = composerReserved;
  /** A reclaim can resolve after this form unmounts (left the route, closed the
   *  pane). Its refs still hold the origin chat, so the restore would pass its
   *  checks and write into a dead form — reporting success and making the caller
   *  drop the steer, losing the text. Track mount so the restore refuses and the
   *  caller queues it instead. */
  const composerMountedRef = useRef(true);
  useEffect(
    () => () => {
      composerMountedRef.current = false;
    },
    [],
  );

  /** A draft is anything the user has staged, not just typed: `editToComposer`
   *  MERGES the steer's attachments into the composer's file map and its quotes
   *  and skill picks into their atoms, so restoring over staged context would
   *  glue the two submissions together. */
  const hasStagedComposerContext = useRecoilCallback(
    ({ snapshot }) =>
      (convoId: string) =>
        snapshot.getLoadable(store.pendingQuotesByConvoId(convoId)).getValue().length > 0 ||
        snapshot.getLoadable(store.pendingManualSkillsByConvoId(convoId)).getValue().length > 0,
    [],
  );

  /**
   * `editToComposer` for a steer whose reclaim was a round-trip: by the time it
   * resolves the composer may have moved on. Refuses (returning false, so the
   * caller re-homes the words instead of dropping them) rather than overwrite a
   * draft the user has since staged, or drop a steer into whatever chat they
   * navigated to.
   */
  const restoreReclaimedSteer = useCallback(
    (
      text: string,
      steerFiles: TMessage['files'],
      context: QueuedMessageContext,
      originConversationId: string,
    ): boolean => {
      if (!composerMountedRef.current) {
        return false;
      }
      const liveConversationId = liveConversationIdRef.current;
      if (originConversationId !== liveConversationId) {
        return false;
      }
      /** Answer mode owns the composer: `onSubmit` hands its text to
       *  `answerMode.submitText` before any send/steer routing, so restoring
       *  here would turn the steer into the tool's answer on the next Enter. */
      if (liveAnswerModeRef.current) {
        return false;
      }
      if (
        (methods.getValues('text') ?? '').trim().length > 0 ||
        (liveFilesRef.current?.size ?? 0) > 0 ||
        hasStagedComposerContext(liveConversationId)
      ) {
        return false;
      }
      editToComposer(text, steerFiles, context);
      return true;
    },
    [methods, editToComposer, hasStagedComposerContext],
  );

  /** ⌘/Ctrl+Enter = the non-default during-run action, ⌥/Alt+Enter =
   *  interrupt & send (discards the answer), ⌘/Ctrl+Shift+Enter = interrupt &
   *  steer (keeps it) — all counterparts of Enter's `submitDuringRun`. */
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
    disabled: disableInputs,
    // The composer IS the free-form answer box while a question pause is live.
    placeholder: composerReserved ? answerPlaceholder : placeholder,
    // Enter stays live during a run when it can steer/queue instead of send.
    allowSubmitWhileGenerating: steering.duringRunActive,
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

  useEffect(() => {
    if (textAreaRef.current) {
      const style = window.getComputedStyle(textAreaRef.current);
      const lineHeight = parseFloat(style.lineHeight);
      setVisualRowCount(Math.floor(textAreaRef.current.scrollHeight / lineHeight));
    }
  }, [textValue]);

  useEffect(() => {
    if (isEditingBadges && backupBadges.length === 0) {
      setBackupBadges([...badges]);
    }
  }, [isEditingBadges, badges, backupBadges.length]);

  const handleSaveBadges = useCallback(() => {
    setIsEditingBadges(false);
    setBackupBadges([]);
  }, [setIsEditingBadges, setBackupBadges]);

  const handleCancelBadges = useCallback(() => {
    if (backupBadges.length > 0) {
      setBadges([...backupBadges]);
    }
    setIsEditingBadges(false);
    setBackupBadges([]);
  }, [backupBadges, setBadges, setIsEditingBadges]);

  const isMoreThanThreeRows = visualRowCount > 3;

  /** One button slot while a run is generating: with composer text the send
   *  button takes over (Enter steers/queues; hover reveals all actions);
   *  clearing the text restores Stop. */
  const duringRunSlot = (() => {
    if (steering.duringRunActive && (textValue?.trim() ?? '') !== '') {
      return (
        <DuringRunSendButton
          ref={submitButtonRef}
          control={methods.control}
          steering={steering}
          getText={() => methods.getValues('text')}
          onConsumed={consumeComposer}
          disabled={filesLoading}
        />
      );
    }
    if (showStopButton) {
      return <StopButton stop={handleStopGenerating} setShowStopButton={setShowStopButton} />;
    }
    return null;
  })();

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
      <div className="relative flex h-full min-w-0 flex-1 items-stretch md:flex-col">
        {/* Primary composer owns the selection popup so split-view doesn't double it. */}
        {index === 0 && quotesEnabled && <QuoteButton conversationId={conversationId} />}
        {/* `relative` anchors the in-flight steer overlay, which floats above
            the composer (`bottom-full`) over the bottom of the thread. */}
        <div className="relative flex w-full flex-col">
          {/* Run-scoped: `enabled` alone is any primary composer on a steerable
              endpoint, so a chip that outlives the run would strand a bubble. */}
          {steering.enabled && isSubmitting && (
            <InFlightSteers
              steering={steering}
              conversationId={conversationId}
              onRestoreToComposer={restoreReclaimedSteer}
            />
          )}
          {(project || codeWorkspace.visible) && (
            <div
              data-testid="composer-context-rail"
              className={cn(
                'mx-4 -mb-3 flex min-w-0 flex-wrap items-center gap-1 rounded-t-2xl',
                'border border-border-light bg-surface-secondary px-2 pb-4 pt-1',
                isRTL && 'flex-row-reverse',
              )}
            >
              {project ? <ProjectLandingChip project={project} /> : null}
              {codeWorkspace.visible ? (
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
              data-testid="composer-surface"
              onClick={handleContainerClick}
              className={cn(
                /* The surface runs to the viewport floor below `sm`, where it is
                   squared off at the bottom (`rounded-t-3xl`) and no disclaimer
                   follows it — so the action row is the last thing in it, with no
                   band of padding under the buttons. */
                'relative flex w-full flex-grow flex-col overflow-hidden rounded-t-3xl sm:rounded-3xl',
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
              <PendingManualSkillsChips conversationId={conversationId} />
              {quotesEnabled && (
                <PendingQuoteChips conversationId={conversationId} focusComposer={focusTextArea} />
              )}
              {steering.enabled && (
                <PendingSteerChips
                  conversationId={conversationId}
                  steering={steering}
                  onEditToComposer={editToComposer}
                  onRestoreToComposer={restoreReclaimedSteer}
                />
              )}
              {/* WIP */}
              <EditBadges
                isEditingChatBadges={isEditingBadges}
                handleCancelBadges={handleCancelBadges}
                handleSaveBadges={handleSaveBadges}
                setBadges={setBadges}
              />
              <FileFormChat
                index={index}
                conversation={conversation}
                files={files}
                setFiles={setFiles}
                setFilesLoading={setFilesLoading}
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
                      onClick={handleFocusOrClick}
                      style={{ height: 44, overflowY: 'auto' }}
                      className={cn(
                        baseClasses,
                        removeFocusRings,
                        'scrollbar-hover transition-[max-height] duration-200 disabled:cursor-not-allowed',
                      )}
                    />
                  </div>
                  <div className="flex flex-col items-start justify-start pr-2.5 pt-1.5">
                    <CollapseChat
                      isCollapsed={isCollapsed}
                      isScrollable={isMoreThanThreeRows}
                      setIsCollapsed={setIsCollapsed}
                    />
                  </div>
                </div>
              )}
              <div
                className={cn(
                  '@container flex flex-wrap items-center gap-2 px-2 pb-2',
                  isRTL ? 'flex-row-reverse' : 'flex-row',
                )}
              >
                <div className="shrink-0">
                  <AttachFileChat
                    conversation={conversation}
                    disableInputs={disableInputs}
                    files={files}
                    setFiles={setFiles}
                    setFilesLoading={setFilesLoading}
                  />
                </div>
                <BadgeRow
                  showEphemeralBadges={
                    !!endpoint &&
                    !hideBadgeRow &&
                    !isAgentsEndpoint(endpoint) &&
                    !isAssistantsEndpoint(endpoint)
                  }
                  isSubmitting={isSubmitting}
                  conversationId={conversationId}
                  specName={conversation?.spec}
                  onChange={setBadges}
                  isInChat={
                    Array.isArray(conversation?.messages) && conversation.messages.length >= 1
                  }
                />
                <CodeApprovalMenu
                  conversation={conversation}
                  addedConversation={addedConvo}
                  setConversation={setConversation}
                  disabled={disableInputs}
                />
                {index === 0 && conversationId != null && (
                  <PendingToolApprovalButton conversationId={conversationId} />
                )}
                <div className="grow" />
                <TokenUsage index={index} conversation={conversation} isSubmitting={isSubmitting} />
                {SpeechToText && (
                  <AudioRecorder
                    methods={methods}
                    ask={submitComposerText}
                    disabled={disableInputs || isNotAppendable}
                    isSubmitting={isSubmitting}
                  />
                )}
                {steering.duringRunActive &&
                  steering.canControlGeneration &&
                  (textValue?.trim() ?? '') !== '' && (
                    <div className="shrink-0">
                      <InterruptSteerButton
                        steering={steering}
                        getText={() => methods.getValues('text')}
                        onConsumed={consumeComposer}
                        disabled={filesLoading}
                      />
                    </div>
                  )}
                <div className={cn('shrink-0', isRTL ? 'mr-auto' : 'ml-auto')}>
                  {isSubmitting &&
                  (showStopButton || steering.duringRunActive) &&
                  !answerMode.composerAnswers
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
                      )}
                </div>
              </div>
              {TextToSpeech && automaticPlayback && <AutoPlayAudio index={index} />}
            </div>
          </div>
        </div>
      </div>
    </form>
  );
});
ChatForm.displayName = 'ChatForm';

/**
 * Wrapper that subscribes to ChatContext and passes stable individual values
 * to the memo'd ChatForm. This prevents ChatForm from re-rendering on every
 * streaming chunk — it only re-renders when the specific values it uses change.
 */
function ChatFormWrapper({
  index = 0,
  placeholder,
  project,
  isLandingPage,
  footerBelow,
  centerFormOnLanding,
}: {
  index?: number;
  placeholder?: string;
  project?: TChatProject;
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
