import type { MessagesHost } from '../react/messages/host';

/** A messages host for specs: locale clock, no slots, no forking, inert scrolling, with the
 *  members a spec needs overridden. */
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
    useScrolling: () => ({
      contentRef: { current: null },
      scrollableRef: { current: null },
      messagesEndRef: { current: null },
      handleSmoothToRef: () => undefined,
      debouncedHandleScroll: () => undefined,
      handleNearBottomChange: () => undefined,
    }),
    useScreenshotTarget: () => undefined,
    useAutoScroll: () => false,
    useConversationSeen: () => () => undefined,
    ...overrides,
  };
}
