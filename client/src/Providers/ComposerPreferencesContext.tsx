import { createContext, useContext } from 'react';

/**
 * The reader's composer preferences, which belong to the app and which a composer only
 * consumes. The chat view reads them once and hands them to every composer under it: main
 * chat's, and the one of a conversation open beside it.
 */
export type ComposerPreferences = {
  /** Whether Enter sends the message rather than adding a line. */
  enterToSend: boolean;
  /** Seconds after which dictated text is sent by itself; negative for never. */
  autoSendText: number;
  /** Whether the shell has loaded the speech settings yet; dictation stays off until it has. */
  speechSettingsInitialized: boolean;
  /** Whether a conversation may change endpoint and keep its messages, or starts anew instead. */
  modularChat: boolean;
};

/** The preferences' own defaults, for a composer drawn outside a chat view. */
export const defaultComposerPreferences: ComposerPreferences = {
  enterToSend: true,
  autoSendText: -1,
  speechSettingsInitialized: false,
  modularChat: true,
};

export const ComposerPreferencesContext = createContext<ComposerPreferences>(
  defaultComposerPreferences,
);

export const useComposerPreferences = (): ComposerPreferences =>
  useContext(ComposerPreferencesContext);
