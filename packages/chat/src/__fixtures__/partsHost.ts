import type { MessagePartsHost } from '../react/host';

/** A parts host that renders nothing app-specific: no markdown, icons, files or preferences. */
export function createMessagePartsHost(
  overrides: Partial<MessagePartsHost> = {},
): MessagePartsHost {
  return {
    useMessage: () => ({ messageId: '' }),
    renderMarkdown: ({ content }) => content,
    useSmoothStreaming: () => false,
    useAgent: () => undefined,
    renderAgentIcon: () => null,
    renderAgentAvatar: () => null,
    renderContentParts: () => null,
    renderImage: () => null,
    renderFilePreview: () => null,
    useFontSize: () => 'text-base',
    useShowThinking: () => false,
    useAutoExpandTools: () => false,
    useLaTeXParsing: () => false,
    useChatDirection: () => 'auto',
    useUserTextPreferences: () => ({
      enableUserMsgMarkdown: false,
      collapseLongUserMessages: false,
      usernameDisplay: false,
    }),
    useUser: () => undefined,
    useFileMap: () => undefined,
    useToast: () => () => undefined,
    useSandboxStarting: () => false,
    useToolArtifactClaim: () => [null, () => undefined],
    useSteerEscalating: () => false,
    usePaneConversationId: () => null,
    useLiveAppliedSteer: () => [false, () => undefined],
    useShare: () => ({}),
    ...overrides,
  };
}
