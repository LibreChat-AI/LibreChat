/** React bindings for the core `Chat`: providers and `useChat`. Populated as the hooks move in. */
export * from './react/chat';
export * from './react/stream';
export * from './react/subagents';
export * from './react/usage';
export * from './react/thread';
export * from './react/latest';
export * from './react/approval';
export { MessageContext, MessagePartIndex, useMessageContext } from './react/message';
export {
  useMessagePartsHost,
  MessagePartsHostProvider,
  setDefaultMessagePartsHost,
} from './react/host';
export type {
  MessagePartsHost,
  MessagePartsUser,
  MessagePartsToast,
  MessagePartsShare,
  ContentPartsSlotProps,
  MessagePartMessage,
  MessagePartsMarkdownProps,
  MessagePartsImageProps,
  MessagePartsFilePreviewProps,
  MessagePartsUserTextPreferences,
} from './react/host';
export {
  resetSteerFamilies,
  escalatingSteerFamily,
  pendingSteersByConvoId,
  liveAppliedSteerFamily,
  liveAppliedSteerIdsAtom,
  appliedSteerIdsByConvoId,
  revealedQueuedTurnFamily,
  acceptedSteerClientIdsByConvoId,
  pendingSteerCancelClientIdsFamily,
  activeGenerationCreatedAtByConvoId,
  activeGenerationProtocolVersionByConvoId,
} from './react/steer/atoms';
export type { RevealedQueuedTurn } from './react/steer/atoms';
export {
  runEndByIndex,
  resetQueueFamilies,
  isDetachedRunManual,
  detachedRunByConvoId,
  drainAfterAbortByIndex,
  pendingRunEndByConvoId,
  stopRequestedByConvoId,
  queuedMessagesByConvoId,
  settledQueuedTurnReceiptsByConvoId,
  pendingQueuedTurnEnqueueIdsByConvoId,
} from './react/steer/queue';
export { recoveryDispositionsFamily } from './react/steer/recovery';
export { ComposerRestoreProvider, useComposerRestoreHost } from './react/steer/restore';
export type { RestoreToComposer, RewakeDrain, ComposerRestoreHost } from './react/steer/restore';
export {
  getReasoningStateKey,
  pendingQuotesByConvoId,
  pendingManualSkillsByConvoId,
  clearPendingComposerContext,
  pendingReasoningOverrideFamily,
  clearPendingReasoningOverrides,
} from './react/composer';
export {
  submissionByIndex,
  clearSubmissions,
  useSubmission,
  useClearSubmissions,
  isSubmittingFamily,
  anySubmittingAtom,
  resetSubmitting,
  useIsSubmitting,
} from './react/submission';
export type { PaneIndex, SubmissionAtom } from './react/submission';
export {
  submissionStartFamily,
  showStopButtonByIndex,
  abortScrollFamily,
  launchedConversationFamily,
} from './react/generation';
export { SteerHostProvider, useSteerHost } from './react/steer/host';
export type {
  SteerHost,
  SteerPane,
  SteerSettings,
  QueuedTurnCache,
  QueuedTurnSnapshot,
  SteerMessageKey,
  SteerNotification,
  SteerRequestCallbacks,
} from './react/steer/host';
export { presetFamily, filesFamily, optionSettingsFamily } from './react/pane';
export type { PaneOptionSettings } from './react/pane';
export { default as useSteering } from './react/steering/useSteering';
export type { SteeringControls, UseSteeringParams } from './react/steering/useSteering';
export type { ComposerFile, ComposerFileSetter } from './react/steering/types';
export {
  default as useSteerCancel,
  useSteerRehome,
  useSteerReclaim,
  useSteerMoveToQueue,
} from './react/steering/useSteerCancel';
export type {
  SteerRehomeOptions,
  SteerCancelOutcome,
  SteerRehomeTarget,
} from './react/steering/useSteerCancel';
export { default as useSteerConvert } from './react/steering/useSteerConvert';
export type { ConvertibleSteer, SteerConvertOptions } from './react/steering/useSteerConvert';
export { default as useSteerEscalate } from './react/steering/useSteerEscalate';
export type { EscalateTarget } from './react/steering/useSteerEscalate';
export { resolveAcknowledgedSteer } from './react/steering/chips';
export { default as useQueueDrain } from './react/steering/useQueueDrain';
export { default as useSteerRecovery } from './react/steering/useSteerRecovery';
export type { SteerRecoveryActions } from './react/steering/useSteerRecovery';
export {
  default as useQueuedTurnReveal,
  hasRevealSuccessor,
  shouldRollbackReveal,
  buildRevealedMessage,
} from './react/steering/useQueuedTurnReveal';
export { useCoreChat } from './react/core';
export { useSnapshot } from './react/snapshot';
export { ReactQueryChatState } from './react/state';
export type { Subscribe, SnapshotOptions } from './react/snapshot';
export type { UseCoreChatOptions, CoreChatHelpers } from './react/core';
export type { ReactQueryChatStateOptions } from './react/state';
export { composerLiftFamily } from './react/lift';
export { showSkillsPopoverFamily } from './react/skills';
export { useComposerOverlay, composerOverlayCountFamily } from './react/overlay';
export { default as useTimeTick } from './react/tick';
export { default as useGenerationsByLatest } from './react/messages/generations';
export type { Generations, TUseGenerations } from './react/messages/generations';
export { default as useConversationSeen } from './react/messages/useConversationSeen';
export {
  reconcileMessageContentLayout,
  getRenderedContentMaxScrollTop,
  scheduleMessageContentLayoutReconcile,
} from './react/messages/messageLayout';
export {
  useMessagesHost,
  MessagesHostProvider,
  setDefaultMessagesHost,
  MessageIconSlot,
} from './react/messages/host';
export type {
  ForkEvents,
  MessageCopy,
  MessagesHost,
  MarkdownVariant,
  MessageCopyInput,
  MessageFeedbackWrite,
  MessageFeedbackEvents,
  ForkPreferences,
  ForkConversation,
  ActivitySlotProps,
  ReportNearBottom,
  SeenReply,
  ReplyProofSource,
  ConversationSeenSource,
  MessageIconData,
  MessageIconProps,
  MessageAudioProps,
  MessageAudioButtonProps,
  MessageSlotProps,
  WakeupSlotProps,
  MessageBodySlotProps,
} from './react/messages/host';
export { default as useStreamedAttachments } from './react/messages/useStreamedAttachments';
export { default as useMessageProcess } from './react/messages/useMessageProcess';
export type { MessageProcess } from './react/messages/useMessageProcess';
export { default as useContentMetadata } from './react/messages/useContentMetadata';
export type { ContentMetadataResult } from './react/messages/useContentMetadata';
export { default as useMemoizedChatContext } from './react/messages/useMemoizedChatContext';
export type { MemoizedChatContext } from './react/messages/useMemoizedChatContext';
export type {
  TMessageChatContext,
  TMessageProps,
  ThreadMessageProps,
} from './react/messages/types';
export {
  areMessageFilesEqual,
  areMessageFieldsEqual,
  isSameTailRelation,
  areMessageRowPropsEqual,
} from './react/messages/equal';
export { AuthorContext, useAuthorContext } from './react/messages/author';
export type { TMessageAuthor } from './react/messages/author';
export { ErrorSourceProvider, useErrorSource } from './react/messages/error';
export type { ErrorSource } from './react/messages/error';
export { MessageSurfaceContext } from './react/messages/surface';
export {
  MessagesViewContext,
  MessagesViewProvider,
  useMessagesSubmission,
  useMessagesOperations,
  useMessagesViewContext,
  useMessagesIsSubmitting,
  useMessagesConversation,
  MessagesOperationsContext,
  MessagesSubmittingContext,
  useIsMessagesViewReadOnly,
  useOptionalMessagesOperations,
  useOptionalMessagesConversation,
} from './react/messages/view';
export type {
  MessagesEditing,
  MessagesOperations,
  MessagesSubmission,
  MessagesConversation,
  MessagesViewContextValue,
} from './react/messages/view';
export type { MessageSurface } from './react/messages/surface';
export {
  GeneratedToolLabelContext,
  SoleToolContext,
  LoneGroupContext,
  useToolExpansion,
  useToolAutoExpand,
  useToolDisclosure,
  reasoningDisclosure,
  ToolDisclosureContext,
  useToolContentPending,
  useToolContentRequest,
  useReasoningDisclosure,
  ToolContentQueryContext,
  ToolDisclosureKeyContext,
  ToolContentPendingContext,
  ToolContentRequestContext,
  toolPanelSpacingClassName,
  ReasoningDisclosureContext,
} from './react/parts/disclosure';
export type {
  ToolDisclosures,
  ToolContentQuery,
  ReasoningDisclosures,
} from './react/parts/disclosure';
export { boundIntentLabel, getToolCallIntent, useToolCallIntent } from './react/parts/intent';
export { default as useFollowScroll } from './react/parts/useFollowScroll';
export { default as useRowHandoff } from './react/parts/handoff';
export {
  askAnswerTextAtom,
  useAskAnswerHost,
  askSubmitStatusAtom,
  askAnswerCheckedAtom,
  AskAnswerHostProvider,
  askAnswerSelectionAtom,
  expandedAskActionsAtom,
  releasedComposerTextAtom,
} from './react/parts/ask';
export type { AskAnswerStatus, ReleasedComposerStash } from './react/parts/ask';
export { default as useComposerItems } from './react/items';
export type { ComposerItem, ComposerItemKind } from './react/items';
export { useFilesHost, FilesHostProvider } from './react/files';
export type { FilesHost, FileDeleteScope, FileMapSetter } from './react/files';
export { default as useReducedMotion } from './react/motion';
export { default as useElementSize } from './react/size';
export { default as useAudioLevels, frameLevel } from './react/levels';
export { default as useInitPopoverInput } from './react/popover';
export { useComposerHost, ComposerHostProvider } from './react/input';
export type {
  ComposerHost,
  CommandListRow,
  CommandListProps,
  ComposerShortcutAction,
} from './react/input';
export {
  RowMountProvider,
  useRowMountWindow,
  useProgressiveRowMount,
  completeProgressiveRowMounts,
} from './react/messages/useProgressiveRowMount';
export type { RowMountWindow } from './react/messages/useProgressiveRowMount';
export {
  default as useScrollbarGutter,
  useScrollbarGutterSeed,
  SCROLLBAR_GUTTER_PROPERTY,
} from './react/messages/useScrollbarGutter';

/** Part disclosure and layout helpers moved from the app. */
export { default as useProgress } from './react/parts/useProgress';
export { default as useThrottledValue } from './react/parts/useThrottledValue';
export { default as useLazyCollapseBody } from './react/parts/useLazyCollapseBody';
