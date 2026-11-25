import type { ChatContract } from '../react/chat/contract';

const noop = (): void => undefined;

/** A pane's chat contract with inert members: no conversation, nothing in flight, no files.
 *  Specs override the members the component under test reads. */
export function createChatContract(overrides: Partial<ChatContract> = {}): ChatContract {
  return {
    index: 0,
    conversation: null,
    setConversation: noop,
    newConversation: noop,
    preset: null,
    setPreset: noop,
    optionSettings: {},
    setOptionSettings: noop,
    getMessages: () => undefined,
    messagesKey: '',
    setMessages: noop,
    subscribeMessages: () => noop,
    getMessagesRevision: () => 0,
    setSiblingIdx: noop,
    latestMessageId: undefined,
    latestMessageDepth: undefined,
    useLiveAttachments: () => ({}),
    ask: noop,
    regenerate: noop,
    isSubmitting: false,
    setIsSubmitting: noop,
    handleRegenerate: noop,
    handleContinue: noop,
    stopGenerating: () => Promise.resolve(),
    handleStopGenerating: noop,
    abortScroll: false,
    setAbortScroll: noop,
    files: new Map(),
    setFiles: noop,
    filesLoading: false,
    setFilesLoading: noop,
    feedbackEnabled: false,
    getMappingOptions: () => ({}),
    ...overrides,
  };
}
