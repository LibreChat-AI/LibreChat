/** React bindings for the core `Chat`: providers and `useChat`. Populated as the hooks move in. */
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
  MessagePartMessage,
  MessagePartsMarkdownProps,
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
