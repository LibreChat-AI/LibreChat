/** Themed message and part components. Populated as the components move in. */
export { Part } from './components/Part';
export { default as Text } from './components/Text';
export { default as Summary } from './components/Summary';
export { default as EmptyText } from './components/EmptyText';
export { default as AgentUpdate } from './components/AgentUpdate';
export { default as CollapsibleText } from './components/CollapsibleText';
export type {
  PartProps,
  ContentPart,
  PartRenderer,
  ToolRenderer,
  AgentToolCall,
  PartRenderers,
  PartRenderProps,
  ToolRenderProps,
} from './components/Part';

/** Composer: the chat input, its controls and the steering queue. */
export { default as StopButton } from './components/composer/StopButton';
export { default as MentionItem } from './components/composer/MentionItem';
export { default as MentionPopover } from './components/composer/popover/Mention';
export { default as PromptsPopover } from './components/composer/popover/Prompts';
export { default as SkillsPopover } from './components/composer/popover/Skills';
export { default as ComposerField } from './components/composer/input/Field';
export { default as ComposerActions } from './components/composer/input/Actions';
export {
  default as ComposerFrame,
  COMPOSER_FOCUS_OWNER_ATTRIBUTE,
} from './components/composer/Frame';
export { default as CommandPopover } from './components/composer/popover/Command';
export { default as CollapseChat } from './components/composer/CollapseChat';
export { default as ComposerChip } from './components/composer/bar/Chip';
export { default as composerClearance } from './components/composer/clearance';
export { default as SteerReceipt } from './components/composer/steering/Receipt';
export { default as ComposerQueue } from './components/composer/steering/Queue';
export type { QueueProps as ComposerQueueProps } from './components/composer/steering/Queue';
export { submitFromComposer } from './components/composer/submit';
export { STEER_DOT, STEER_ICON, QUEUE_ICON } from './components/composer/steering/identity';
export {
  useQueuedTurnPortal,
  QueuedTurnPortalProvider,
} from './components/composer/steering/QueuedTurnPortal';
export type { ComposerSubmitRoute } from './components/composer/submit';
export type { MentionItemProps } from './components/composer/MentionItem';
export type { MentionPopoverProps } from './components/composer/popover/Mention';
export type { PromptsPopoverProps } from './components/composer/popover/Prompts';
export type { ComposerFieldProps } from './components/composer/input/Field';
export type { ComposerActionsProps } from './components/composer/input/Actions';
export type { ComposerFrameProps } from './components/composer/Frame';
export type {
  SkillsPopoverProps,
  SkillsPopoverNotices,
} from './components/composer/popover/Skills';
export type {
  CommandOption,
  CommandPopoverProps,
  CommandDismissReason,
} from './components/composer/popover/Command';
export type { ChipProps as ComposerChipProps } from './components/composer/bar/Chip';
export type { SteerReceiptState } from './components/composer/steering/Receipt';
export { default as FileUpload } from './components/composer/files/FileUpload';
export { default as RemoveFile } from './components/composer/files/RemoveFile';
export { default as SourceIcon } from './components/composer/files/SourceIcon';
export { default as FilePreview } from './components/composer/files/FilePreview';
export { default as ProgressCircle } from './components/composer/files/ProgressCircle';
export { default as FileContainer } from './components/composer/files/FileContainer';
export { default as FileRow, FileRowWrapper } from './components/composer/files/FileRow';
export type { FileRowProps } from './components/composer/files/FileRow';
export { default as ComposerTray } from './components/composer/Tray';
export type { TrayProps as ComposerTrayProps } from './components/composer/Tray';
export { default as DragDropOverlay } from './components/composer/files/DragDropOverlay';
export { default as PastedTextDialog } from './components/composer/files/PastedTextDialog';
export { getFileType } from './components/composer/files/kinds';
export type { FileKind } from './components/composer/files/kinds';
export type { SubtitleAction } from './components/composer/files/FileContainer';
export type { PastedTextEdit } from './components/composer/files/PastedTextDialog';

/** Message list building blocks: rows, headers, sibling navigation and the streaming timer. */
export { default as SubRow } from './components/messages/SubRow';
export { default as SiblingSwitch } from './components/messages/SiblingSwitch';
export { default as SystemEventHeader } from './components/messages/SystemEvent';
export { SystemEventIcon, systemEventHeaderClasses } from './components/messages/SystemEvent';
export { default as Elapsed, ElapsedTimer, shouldShowElapsed } from './components/messages/Elapsed';
export {
  default as HeaderLabel,
  isDocumentId,
  getHeaderModelName,
  getHeaderHoverLabel,
} from './components/messages/HeaderLabel';
export { messageFooterClasses, revealOnRowHoverClasses } from './components/messages/styles';
export { getRunStepDurationLabels, getElapsedDurationLabels } from './components/messages/duration';
export type { RunStepDurationLabels } from './components/messages/duration';
export { default as MessageRow } from './components/messages/MessageRow';
export { default as WakeupRow } from './components/messages/WakeupRow';
export { default as PendingTurn } from './components/messages/PendingTurn';
export type { PendingTurnProps } from './components/messages/PendingTurn';
export { default as MessageTimestamp } from './components/messages/MessageTimestamp';
export { getMessageRowWidthClass } from './components/messages/width';
export { isValidTimestamp, getMessageTimestamp } from './components/messages/time';
export type { MessageTimestamp as MessageTimestampParts } from './components/messages/time';
export { default as Fork } from './components/messages/Fork';
export { default as Feedback } from './components/messages/Feedback';
export { default as MinimalHoverButtons } from './components/messages/MinimalHoverButtons';
export { default as HoverButtons } from './components/messages/HoverButtons';
export { default as ContentRow } from './components/messages/ContentRow';
export type { ContentRowProps } from './components/messages/ContentRow';
export { default as MessageFooter } from './components/messages/MessageFooter';
export { default as MessageNav } from './components/messages/MessageNav';
export type { MessageFooterProps } from './components/messages/MessageFooter';
export { getMessageAriaLabel, getHeaderPrefixForScreenReader } from './components/messages/labels';

/** Parts: the leaf components and row classes tool cards share. */
export { default as Stdout } from './components/parts/Stdout';
export { default as BareStatus } from './components/parts/BareStatus';
export { default as AuthorHeader } from './components/parts/AuthorHeader';
export { default as CancelledIcon } from './components/parts/CancelledIcon';
export { default as InProgressCall } from './components/parts/InProgressCall';
export {
  ROW_GLYPH_SLOT,
  PANE_COPY_REVEAL,
  FOLD_GLYPH_CLASS,
  TOOL_ROW_CLASSES,
  FOLD_RAIL_CLASSES,
  FOLD_GLYPH_SELECTOR,
  ARTIFACT_ROW_NAV_SPACING,
} from './components/parts/rows';
export { default as AskOptions } from './components/parts/AskOptions';
export { default as AskPopover } from './components/composer/ask/Popover';
export type { LiveAsk, AskAnswerView, AskPopoverProps } from './components/composer/ask/Popover';
export type { AskOption } from './components/parts/AskOptions';
export { default as SkillPills } from './components/parts/SkillPills';
export type { SkillPillsSource } from './components/parts/SkillPills';
export { default as MessageQuotes } from './components/parts/MessageQuotes';
export { default as SteerPart } from './components/parts/SteerPart';
export type { SteerPartProps } from './components/parts/SteerPart';
export {
  default as DiffView,
  diffPreviewText,
  parseUnifiedDiff,
  buildEditPreviewDiff,
} from './components/parts/DiffView';
export type { DiffLine, ParsedDiff, TextEditPreview } from './components/parts/DiffView';

/** Parts: content leaves moved from the app. */
export { default as Container } from './components/parts/Container';
export { default as MemoryInfo } from './components/parts/MemoryInfo';
export { default as DialogImage } from './components/parts/DialogImage';
export { default as PendingSkillCall } from './components/parts/PendingSkillCall';
export { default as ToolCallLimitNotice } from './components/parts/ToolCallLimitNotice';
export { default as ResumeAuthorHeader } from './components/parts/ResumeAuthorHeader';
export { ToolAuthWarning, ToolAuthWarningContext } from './components/parts/auth';
export { ToolPreparation, useToolPreparation } from './components/parts/preparation';
export {
  FailedRevealPill,
  useFailedReveal,
  FailedRevealContext,
  useFailedRevealTrigger,
} from './components/parts/reveal';
export type { FailedReveal } from './components/parts/reveal';
export {
  FoldRail,
  RailGlyph,
  litFoldPath,
  useFoldPath,
  useRailHover,
  revealFoldHeader,
  FoldHeaderContext,
} from './components/parts/rail';
export type { LitRail, RailHover } from './components/parts/rail';
export {
  backgroundTaskNoteKey,
  backgroundTaskNoticeKey,
  backgroundTaskMessageKey,
  backgroundListGuidanceKeys,
} from './components/parts/guidance';
export { default as AttachmentImage } from './components/composer/files/Image';
export { default as ImagePreview } from './components/composer/files/ImagePreview';
export { default as SendButton } from './components/composer/SendButton';
export { default as QuoteButton } from './components/composer/QuoteButton';
export { default as ComposerHints } from './components/composer/bar/Hints';
export { default as ComposerWaveform } from './components/composer/bar/Waveform';
export {
  default as ComposerEffort,
  leanFor,
  effortRank,
  resolveEffortLabel,
} from './components/composer/bar/Effort';
export { default as ReasoningControl } from './components/composer/bar/Reasoning';
export type { ReasoningControlProps } from './components/composer/bar/Reasoning';
export { default as ThinkingControl } from './components/composer/bar/Thinking';
export type { ThinkingControlProps } from './components/composer/bar/Thinking';
export { default as ContextUsage } from './components/composer/usage/Usage';
export type { UsageProps as ContextUsageProps } from './components/composer/usage/Usage';
export { default as ContextGauge } from './components/composer/usage/Gauge';
export type { GaugeProps as ContextGaugeProps, GaugeTone } from './components/composer/usage/Gauge';
export { default as ContextUsagePopover } from './components/composer/usage/Popover';
export type { UsagePopoverProps as ContextUsagePopoverProps } from './components/composer/usage/Popover';
export { default as CompactAction } from './components/composer/usage/CompactAction';
export type { CompactActionProps } from './components/composer/usage/CompactAction';
export { default as ContextBreakdown } from './components/composer/usage/Breakdown';
export type { BreakdownProps as ContextBreakdownProps } from './components/composer/usage/Breakdown';
export { default as EscalateNowButton } from './components/composer/EscalateNowButton';
export { default as DuringRunSendButton } from './components/composer/DuringRunSendButton';
export { composerHintId } from './components/composer/bar/Hints';
export type {
  ComposerHint,
  ComposerHintKind,
  ComposerHintState,
} from './components/composer/bar/hint';

/** Chat pane: the layout that seats the header, message column and composer band. */
export { default as ChatPane } from './components/pane/ChatPane';
export { getChatPaneView } from './components/pane/view';
export type { ChatPaneProps } from './components/pane/ChatPane';
export type { ChatPaneView, ChatPaneColumn } from './components/pane/view';
export { default as ChatScreen } from './components/pane/Screen';
export { default as ChatStarters } from './components/pane/starters';
export { getChatPaneChrome } from './components/pane/chrome';
export type {
  ChatScreenProps,
  ChatScreenComposerProps,
  ChatScreenMessagesProps,
  ChatScreenMessagesSlots,
} from './components/pane/Screen';
export type { ChatPaneChrome } from './components/pane/chrome';
export type { ChatStartersProps } from './components/pane/starters';

/** Message list root: the scroll container, mount window and pending tail around the thread. */
export { default as MessagesView } from './components/messages/MessagesView';
export { default as MessagesThread } from './components/messages/thread/Thread';
export type {
  MessagesViewProps,
  MessagesThreadProps,
  MessagesScrollButtonProps,
} from './components/messages/MessagesView';

export { EventSubagentActivityGroup } from './components/subagents/activity';
export { default as ThreadMessage } from './components/messages/thread/Message';
export { default as MessageContent } from './components/messages/MessageContent';
export { default as ContentRender } from './components/messages/ContentRender';
export { default as MessageRender } from './components/messages/MessageRender';
export { default as MessageParts } from './components/messages/MessageParts';
export { default as Message } from './components/messages/Message';
export { default as useMessageActions } from './components/messages/useMessageActions';
export type { TMessageActions, MessageActions } from './components/messages/useMessageActions';
export { default as useMessageHelpers } from './components/messages/useMessageHelpers';
export type { MessageHelpers } from './components/messages/useMessageHelpers';
export { default as useAttachments } from './components/messages/useAttachments';
export { useSearchResultsByTurn } from './components/messages/useSearchResultsByTurn';
export { default as ScrollToBottom } from './components/messages/ScrollToBottom';
export {
  SubagentStatus,
  SubagentActivity,
  getActivityContent,
  SubagentActivityContent,
  SubagentActivityScrollSurface,
} from './components/subagents/transcript';
export { default as SubagentConversation } from './components/subagents/conversation';
export { default as SharedSubagentActivityDialog } from './components/subagents/shared';
export { loadSubagentThreadPanel } from './components/subagents/load';

/** Part helpers moved from the app: copy and action buttons, language icons, expand/collapse. */
export {
  default as useExpandCollapse,
  EXPAND_TRANSITION,
  REDUCED_MOTION_EXPAND_TRANSITION,
} from './components/parts/useExpandCollapse';
export { default as CopyButton } from './components/parts/CopyButton';
export { default as ActionButton } from './components/parts/ActionButton';
export { default as LangIcon, hasLangIcon } from './components/parts/LangIcon';
