import { memo, useRef, useMemo, useEffect, useState, useCallback } from 'react';
import { useRecoilValue } from 'recoil';
import { useWatch } from 'react-hook-form';
import { useAtom, useAtomValue } from 'jotai';
import { useNavigate } from 'react-router-dom';
import { useDirection } from '@radix-ui/react-direction';
import { useSteering, showStopButtonByIndex, useComposerRestoreHost } from '@librechat/chat/react';
import {
  PastedTextDialog,
  QuoteButton,
  composerHintId,
  ComposerHints as Hints,
} from '@librechat/chat/components';
import {
  Constants,
  Permissions,
  PermissionTypes,
  isAgentsEndpoint,
  isAssistantsEndpoint,
} from 'librechat-data-provider';
import {
  submitFromComposer,
  composerClearance,
  ComposerField,
  ComposerFrame,
  ComposerActions,
} from '@librechat/chat/components';
import type { TChatProject, TMessage, TConversation } from 'librechat-data-provider';
import type { QueuedMessageContext } from '@librechat/chat';
import type { SetterOrUpdater } from 'recoil';
import type { ExtendedFile, FileSetter, ConvoGenerator, TAskFunction } from '~/common';
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
  getComposerDraftId,
  getPendingDraftId,
  clearAllDrafts,
  getFilesDraftCached,
  isPastedTextFileMarked,
} from '~/utils';
import {
  useChatContext,
  useChatFormContext,
  useAddedChatContext,
  useAssistantsMapContext,
  BadgeRowProvider,
} from '~/Providers';
import {
  PendingToolApprovalButton,
  PendingToolApprovalPanel,
} from '~/components/Chat/approval/Review';
import useComposerRestore from '~/hooks/Input/useComposerRestore';
import { useChatSettings } from '~/Providers/ChatSettingsContext';
import usePastedTextEdit from '~/hooks/Files/usePastedTextEdit';
import useAskAnswerMode from '~/hooks/Input/useAskAnswerMode';
import AskUserQuestionPopover from './AskUserQuestionPopover';
import useComposerItems from '~/hooks/Input/useComposerItems';
import useAttachTarget from '~/hooks/Input/useAttachTarget';
import { chatDirectionAtom } from '~/store/chatDirection';
import ProjectLandingChip from '../ProjectLandingChip';
import useHasAccess from '~/hooks/Roles/useHasAccess';
import useDictation from '~/hooks/Input/useDictation';
import { useGetStartupConfig } from '~/data-provider';
import CodeWorkspaceMenu from './CodeWorkspaceMenu';
import CodeApprovalMenu from './CodeApprovalMenu';
import TextareaHeader from './TextareaHeader';
import PromptsCommand from './PromptsCommand';
import SkillsCommand from './SkillsCommand';
import AutoPlayAudio from './AutoPlayAudio';
import { mainTextareaId } from '~/common';
import ToolDialogs from './ToolDialogs';
import Queue from './Composer/Queue';
import Tray from './Composer/Tray';
import Bar from './Composer/Bar';
import Mention from './Mention';
import store from '~/store';

interface ChatFormProps {
  index: number;
  placeholder?: string;
  project?: TChatProject;
  /** The host is reconciling the requested route with its conversation record. */
  routePending: boolean;
  /** Owned by ChatView: which layout the composer sits in — the welcome screen
   *  floats or bottoms it out, a conversation ends the page with it. */
  isLandingPage: boolean;
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

const ChatForm = memo(function ChatForm({
  index,
  placeholder,
  project,
  routePending,
  isLandingPage,
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
  const approvalTriggerRef = useRef<HTMLButtonElement>(null);
  /** The palette anchors to the whole composer, not to its own button, so it
   *  spans the composer width and sits flush above it. */
  const composerBoxRef = useRef<HTMLDivElement>(null);
  useFocusChatEffect(textAreaRef);
  const localize = useLocalize();

  const [, setIsScrollable] = useState(false);
  const [isTextAreaFocused, setIsTextAreaFocused] = useState(false);

  const SpeechToText = useRecoilValue(store.speechToText);
  const TextToSpeech = useRecoilValue(store.textToSpeech);
  const chatDirection = useAtomValue(chatDirectionAtom);
  const automaticPlayback = useRecoilValue(store.automaticPlayback);
  const maximizeChatSpace = useRecoilValue(store.maximizeChatSpace);
  const { isTemporary } = useChatSettings();

  const [showStopButton, setShowStopButton] = useAtom(showStopButtonByIndex(index));
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
  const isNewConversation = conversationId === '' || conversationId === Constants.NEW_CONVO;
  /**
   * The quote feature merges excerpts server-side in `BaseClient.sendMessage`,
   * which the Assistants endpoints bypass, so hide the UI there rather than
   * letting users queue quotes the assistant never receives.
   */
  const quotesEnabled = useMemo(() => !isAssistantsEndpoint(endpoint), [endpoint]);

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

  /** Actions that consume the composer from inside a popup (the during-run
   * hovercard) sit in exempted popup content, so they restore focus themselves. */
  const consumeComposer = useCallback(() => {
    methods.reset();
    focusTextArea();
  }, [methods, focusTextArea]);

  const handleTextareaFocus = useCallback(() => {
    setIsTextAreaFocused(true);
  }, []);

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

  const { consumeDraft, preserveText, settleText } = useAutoSave({
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

  const {
    isPreparing: isPreparingFromUrl,
    settingsError: urlSettingsError,
    clearSettingsError,
  } = useQueryParams({
    textAreaRef,
    routePending,
    onBeforePrompt: preserveText,
    onPromptSettled: settleText,
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
  const { isActionPending } = pastedTextEdit;
  const isPasteActionPending = useCallback(
    (file: ExtendedFile) => isActionPending(file.file_id),
    [isActionPending],
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
  const navigate = useNavigate();
  /** A queued message becomes the first message of a fresh chat through the same
   *  `prompt` + `submit` query contract that deep links already use. */
  const startQueuedInNewChat = useCallback(
    (text: string) => navigate(`/c/new?${new URLSearchParams({ prompt: text, submit: 'true' })}`),
    [navigate],
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
    addedConversation: addedConvo,
    index,
    conversationId,
    conversation,
    codeEnvironmentMode: codeWorkspace.mode,
    isSubmitting,
    answerModeActive: composerReserved,
    composerDisabled: isPreparingFromUrl,
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

  /** Ctrl/Cmd+Enter selects the alternate; both interrupt chords use the same mode. */
  const handleDuringRunModifier = useCallback(
    (kind: 'other' | 'interrupt' | 'preempt') => {
      const text = methods.getValues('text');
      let consumed = false;
      if (kind === 'interrupt') {
        consumed = steering.interruptSteer(text);
      } else if (kind === 'preempt') {
        consumed = steering.interruptSteer(text);
      } else if (steering.effectiveAction !== 'queue') {
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
    /* Only picks the missing-key placeholder; preparation and answer holds live on the textarea. */
    disabled: disableInputs,
    // The composer IS the free-form answer box while a question pause is live.
    placeholder: composerReserved ? answerPlaceholder : placeholder,
    // Enter stays live during a run when it can steer/queue instead of send.
    allowSubmitWhileGenerating: steering.duringRunActive || answerMode.composerAnswers,
    onDuringRunModifier: steering.duringRunActive ? handleDuringRunModifier : undefined,
    answerModeActive: answerMode.composerAnswers,
    enterToSend,
  });

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
  const interfaceDirection = useDirection();
  /** An empty `dir="auto"` field resolves to LTR, which would park an RTL interface's placeholder on
   *  the wrong edge, so the empty field follows the interface until text gives it a direction. */
  const autoDirection = textValue ? 'auto' : interfaceDirection;
  const textDirection = chatDirection === 'auto' ? autoDirection : chatDirection;

  const composerItems = useComposerItems(conversationId, quotesEnabled);
  const attachTarget = useAttachTarget(conversation, disableInputs);
  const hasPromptsAccess = useHasAccess({
    permissionType: PermissionTypes.PROMPTS,
    permission: Permissions.USE,
  });
  const slashCommandEnabled = useRecoilValue(store.slashCommand);
  const atCommandEnabled = useRecoilValue(store.atCommand);
  const idleActions = useMemo(
    () => ({
      prompts: hasPromptsAccess && slashCommandEnabled,
      mentions: atCommandEnabled,
      attach: attachTarget.canAttach,
    }),
    [hasPromptsAccess, slashCommandEnabled, atCommandEnabled, attachTarget.canAttach],
  );
  const { submitText: submitAnswerText } = answerMode;
  const dictationAnswerModeActive = answerMode.composerAnswers;
  const speechDisabled =
    !speechSettingsInitialized ||
    disableInputs ||
    isNotAppendable ||
    answerMode.composerLocked ||
    isPreparingFromUrl;
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
  /** The waveform stands in for the placeholder until words arrive, and is
   *  then the only thing drawn on that line. */
  const listening = dictation.active && (textValue?.trim() ?? '') === '';
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

  /* Memoized for `memo(Bar)`: an inline element is a new identity every render,
     and this component re-renders on every keystroke. */
  const actionSlot = useMemo(
    () => (
      <ComposerActions
        text={textValue ?? ''}
        submitButtonRef={submitButtonRef}
        isSubmitting={isSubmitting}
        answersAsk={answerMode.composerAnswers}
        hasEndpoint={!!endpoint}
        steering={steering}
        isNewConversation={isNewConversation}
        getText={() => methods.getValues('text')}
        onConsumed={consumeComposer}
        enterToSend={enterToSend}
        fileCount={submittableFileCount}
        sendDisabled={
          filesLoading ||
          isPreparingFromUrl ||
          disableInputs ||
          !codeWorkspace.canSubmit ||
          isNotAppendable ||
          answerMode.composerLocked
        }
        duringRunDisabled={filesLoading || isPreparingFromUrl}
        showStopButton={showStopButton}
        setShowStopButton={setShowStopButton}
        stop={handleStopGenerating}
        canStop={canStop}
        isPreparingFromUrl={isPreparingFromUrl}
      />
    ),
    [
      textValue,
      isSubmitting,
      answerMode.composerAnswers,
      answerMode.composerLocked,
      endpoint,
      steering,
      isNewConversation,
      methods,
      consumeComposer,
      enterToSend,
      submittableFileCount,
      filesLoading,
      isPreparingFromUrl,
      disableInputs,
      codeWorkspace.canSubmit,
      isNotAppendable,
      showStopButton,
      setShowStopButton,
      handleStopGenerating,
      canStop,
    ],
  );

  const bottomClearance = composerClearance({
    isLandingPage,
    footerBelow,
    floating: centerFormOnLanding && !isSubmitting,
  });

  /** Answer mode, then during-run steering or queueing (a run in flight, or a
   *  queued follow-up about to start), then an ordinary send: the same route
   *  for typed, dictated, and shortcut-bound submissions. */
  const submitComposerText = useCallback(
    (data: { text: string }): false | void =>
      submitFromComposer(
        {
          answerMode,
          steering,
          submitMessage: (message) => {
            const result = submitMessage(message);
            if (result !== false) {
              clearAllDrafts(getPendingDraftId(index));
            }
            return result;
          },
          reset: () => methods.reset(),
        },
        data,
      ),
    [answerMode, steering, submitMessage, methods, index],
  );

  return (
    <ComposerFrame
      onSubmit={methods.handleSubmit((data) => {
        if (!isPreparingFromUrl && submitComposerText(data) !== false) {
          clearSettingsError();
        }
      })}
      direction={chatDirection}
      maximizeChatSpace={maximizeChatSpace}
      clearanceClassName={bottomClearance}
      focused={isTextAreaFocused}
      isTemporary={isTemporary}
      surfaceRef={composerBoxRef}
      onFocusDraft={focusTextArea}
      /* Primary composer owns the selection popup so split-view doesn't double it. */
      quote={index === 0 && quotesEnabled && <QuoteButton conversationId={conversationId} />}
      queue={
        steering.enabled && (
          <Queue
            steering={steering}
            conversationId={conversationId}
            onRestoreToComposer={restoreReclaimedSteer}
            canRestoreToComposer={canRestoreToComposer}
            onStartNewChat={startQueuedInNewChat}
          />
        )
      }
      contextRail={
        project || codeWorkspace.visible ? (
          <>
            {project ? <ProjectLandingChip project={project} /> : null}
            {codeWorkspace.visible ? (
              <div className="min-w-0">
                <CodeWorkspaceMenu
                  setConversation={setConversation}
                  workspace={codeWorkspace}
                  disabled={disableInputs || isSubmitting}
                />
              </div>
            ) : null}
          </>
        ) : undefined
      }
      popovers={
        <>
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
            <PendingToolApprovalPanel
              conversationId={conversationId}
              triggerRef={approvalTriggerRef}
            />
          )}
          <SkillsCommand
            index={index}
            textAreaRef={textAreaRef}
            conversationId={conversationId}
            agentId={conversation?.agent_id}
          />
        </>
      }
      hints={
        <Hints
          index={index}
          enterToSend={enterToSend}
          hasText={(textValue?.trim() ?? '') !== ''}
          isSubmitting={isSubmitting}
          duringRunActive={steering.duringRunActive}
          canControlGeneration={steering.canControlGeneration}
          duringRunAction={steering.effectiveAction}
          /* A staged reasoning choice forces the message to queue, and the
           send-now chord then queues too; do not advertise it. */
          canSteer={steering.canSteer && steering.pendingReasoningOverride == null}
          answerModeActive={answerMode.active}
          uploadingCount={uploadingCount}
          idleActions={idleActions}
        />
      }
    >
      <TextareaHeader addedConvo={addedConvo} setAddedConvo={setAddedConvo} />
      <Tray
        items={composerItems}
        focusComposer={focusTextArea}
        conversation={conversation}
        files={files}
        setFiles={setFiles}
        setFilesLoading={setFilesLoading}
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
        <ComposerField
          textAreaRef={textAreaRef as React.MutableRefObject<HTMLTextAreaElement | null>}
          inputRef={ref}
          value={textValue ?? ''}
          listening={listening}
          dictationActive={dictation.active}
          locked={answerMode.composerLocked}
          ariaLabel={localize('com_ui_message_input')}
          textareaProps={{
            ...registerProps,
            dir: textDirection,
            disabled:
              disableInputs || isNotAppendable || answerMode.composerLocked || isPreparingFromUrl,
            onPaste: handlePaste,
            onKeyDown: (e) => {
              // Answer mode consumes option-navigation keys from the
              // empty composer; everything else follows the normal path.
              if (answerMode.handleComposerKeyDown(e)) {
                return;
              }
              handleKeyDown(e);
            },
            onKeyUp: handleKeyUp,
            onCompositionStart: handleCompositionStart,
            onCompositionEnd: handleCompositionEnd,
            id: mainTextareaId,
            tabIndex: 0,
            'data-testid': 'text-input',
            onFocus: handleTextareaFocus,
            onBlur: handleTextareaBlur,
            'aria-describedby': cn(
              composerHintId(index),
              (codeWorkspace.state === 'choose' || codeWorkspace.state === 'missing') &&
                `code-workspace-hint-${index}`,
            ),
          }}
        />
      )}
      {(isPreparingFromUrl || urlSettingsError) && (
        <p role="status" className="text-text-secondary px-5 pb-2 text-sm">
          {localize(urlSettingsError ? 'com_ui_url_settings_failed' : 'com_ui_sending')}
        </p>
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
            <div className="flex items-center gap-1.5">
              <CodeApprovalMenu
                conversation={conversation}
                addedConversation={addedConvo}
                codeEnvironmentMode={codeWorkspace.mode}
                setConversation={setConversation}
                disabled={disableInputs}
              />
              {index === 0 && conversationId != null && (
                <PendingToolApprovalButton
                  conversationId={conversationId}
                  triggerRef={approvalTriggerRef}
                />
              )}
            </div>
          }
          actionSlot={actionSlot}
          hasAddedConversation={addedConvo != null}
        />
        <ToolDialogs />
      </BadgeRowProvider>
      {TextToSpeech && automaticPlayback && <AutoPlayAudio index={index} />}
    </ComposerFrame>
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
  routePending = false,
  isLandingPage,
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
  routePending?: boolean;
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
      enterToSend={enterToSend}
      autoSendText={autoSendText}
      speechSettingsInitialized={speechSettingsInitialized}
      placeholder={placeholder}
      project={project}
      routePending={routePending}
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
