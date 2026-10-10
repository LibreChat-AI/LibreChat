import { createContext, useContext } from 'react';
import type { ChatSettings } from '~/hooks/Chat/contract';

/** Stock values, used when no host supplies settings (isolated renders and tests). */
export const defaultChatSettings: ChatSettings = {
  duringRunDefaultAction: 'steer',
  setDuringRunDefaultAction: () => undefined,
  resetVisibleArtifacts: () => undefined,
  saveDrafts: true,
  isTemporary: false,
  setIsTemporary: () => undefined,
  config: { feedbackEnabled: false, canRenameRunningChat: false },
  auth: {},
};

export const ChatSettingsContext = createContext<ChatSettings>(defaultChatSettings);

export const useChatSettings = () => useContext(ChatSettingsContext);
