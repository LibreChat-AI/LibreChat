import { atom } from 'recoil';
import { atomWithLocalStorage } from './utils';

const hideBannerHint = atomWithLocalStorage('hideBannerHint', [] as string[]);

const queriesEnabled = atom<boolean>({
  key: 'queriesEnabled',
  default: true,
});

const showShortcutsDialog = atom<boolean>({
  key: 'showShortcutsDialog',
  default: false,
});

export type KeyboardDeleteTarget = {
  conversationId: string;
  title: string;
};

const keyboardDeleteTarget = atom<KeyboardDeleteTarget | null>({
  key: 'keyboardDeleteTarget',
  default: null,
});

export type ShortcutOverride = {
  mac: string | null;
  other: string | null;
};

const customShortcuts = atomWithLocalStorage<Record<string, ShortcutOverride>>(
  'customKeyboardShortcuts',
  {},
);

/** When false, no keyboard shortcut fires and the UI stops advertising them. */
const shortcutsEnabled = atomWithLocalStorage<boolean>('keyboardShortcutsEnabled', true);

export default {
  hideBannerHint,
  queriesEnabled,
  showShortcutsDialog,
  keyboardDeleteTarget,
  customShortcuts,
  shortcutsEnabled,
};
