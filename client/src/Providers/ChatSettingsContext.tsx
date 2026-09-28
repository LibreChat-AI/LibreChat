import { createContext, useContext } from 'react';

/** Composer action while a run is in flight: fold the text into the run, or queue a new turn. */
export type DuringRunAction = 'steer' | 'queue';

/**
 * App-global preferences the chat reads but does not own. The host supplies them, so the chat
 * hooks never reach into the app's state store for shell settings. A preference belongs here only
 * once every chat reader of it takes it from here: a reader left on the store would act on a
 * different value than a host that supplies its own.
 */
export type ChatSettings = {
  /** Default composer action while a run is in flight. */
  duringRunDefaultAction: DuringRunAction;
  setDuringRunDefaultAction: (action: DuringRunAction) => void;
  /** Whether a steer interrupts the running step instead of waiting for the next one. */
  steerInterruptsByDefault: boolean;
  /** Closes the artifacts panel, called when the active conversation changes. */
  resetVisibleArtifacts: () => void;
};

/** Stock values, used when no host supplies settings (isolated renders and tests). */
export const defaultChatSettings: ChatSettings = {
  duringRunDefaultAction: 'steer',
  setDuringRunDefaultAction: () => undefined,
  steerInterruptsByDefault: false,
  resetVisibleArtifacts: () => undefined,
};

export const ChatSettingsContext = createContext<ChatSettings>(defaultChatSettings);

export const useChatSettings = () => useContext(ChatSettingsContext);
