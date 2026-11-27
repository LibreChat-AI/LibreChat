import { useState, createContext, useContext } from 'react';
import type { TConversation } from 'librechat-data-provider';
import type { ChatSettings, PaneConversationState } from '~/hooks/Chat/contract';

/** A pane conversation held by the calling chat alone, for renders with no host pane store. */
function useLocalPaneConversation(): PaneConversationState {
  const [conversation, setConversation] = useState<TConversation | null>(null);
  return { conversation, setConversation };
}

/** Stock values, used when no host supplies settings (isolated renders and tests). */
export const defaultChatSettings: ChatSettings = {
  duringRunDefaultAction: 'steer',
  setDuringRunDefaultAction: () => undefined,
  resetVisibleArtifacts: () => undefined,
  saveDrafts: true,
  isTemporary: false,
  setIsTemporary: () => undefined,
  getEphemeralAgent: () => null,
  addedConversation: null,
  config: { feedbackEnabled: false, canRenameRunningChat: false },
  auth: {},
  getPaneConversations: () => [],
  usePaneConversation: () => null,
  usePaneConversationState: useLocalPaneConversation,
};

export const ChatSettingsContext = createContext<ChatSettings>(defaultChatSettings);

export const useChatSettings = () => useContext(ChatSettingsContext);
