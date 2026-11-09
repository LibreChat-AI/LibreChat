import type { MessagesHost } from '../react/messages/host';

/** A messages host for specs: locale clock, no slots, no forking, no copying, no thread, no
 *  queued turn, no read-aloud, inert scrolling, with the members a spec needs overridden. */
export function createMessagesHost(overrides: Partial<MessagesHost> = {}): MessagesHost {
  return {
    useHour12: () => undefined,
    renderFiles: () => null,
    useForkPreferences: () => ({
      option: '',
      setOption: () => undefined,
      splitAtTarget: false,
      setSplitAtTarget: () => undefined,
      rememberOption: false,
      setRememberOption: () => undefined,
    }),
    useForkConversation: () => null,
    useMessageCopy: () => ({ copyToClipboard: () => undefined, canCopy: false }),
    useGetMessages: () => () => undefined,
    useHasPendingTurn: () => false,
    renderMessageAudio: () => null,
    useScreenshotTarget: () => undefined,
    useAutoScroll: () => false,
    useConversationMessages: () => undefined,
    useAssistant: () => undefined,
    useGetAddedConvo: () => () => null,
    useStreamedAttachments: () => undefined,
    useMessageFeedback: () => () => undefined,
    useSeenSource: () => ({
      readReply: () => undefined,
      hasReplyProof: () => false,
      markSeen: () => undefined,
      consumeFocusSuppression: () => false,
    }),
    renderMessageIcon: () => null,
    useMaximizeChatSpace: () => false,
    useHideSelectedAuthor: () => false,
    useAgentsMap: () => undefined,
    renderMessageBody: () => null,
    renderWakeup: () => null,
    renderPrivateText: () => null,
    renderActivity: () => null,
    useFileMap: () => undefined,
    ...overrides,
  };
}
