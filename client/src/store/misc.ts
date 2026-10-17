import { atom, selectorFamily } from 'recoil';
import { TAttachment } from 'librechat-data-provider';
import { atomWithLocalStorage } from './utils';

const hideBannerHint = atomWithLocalStorage('hideBannerHint', [] as string[]);

const messageAttachmentsMap = atom<Record<string, TAttachment[] | undefined>>({
  key: 'messageAttachmentsMap',
  default: {},
});

/**
 * Selector to get attachments for a specific conversation.
 */
const conversationAttachmentsSelector = selectorFamily<
  Record<string, TAttachment[]>,
  string | undefined
>({
  key: 'conversationAttachments',
  get:
    (conversationId) =>
    ({ get }) => {
      if (!conversationId) {
        return {};
      }

      const attachmentsMap = get(messageAttachmentsMap);
      const result: Record<string, TAttachment[]> = {};

      // Filter to only include attachments for this conversation
      Object.entries(attachmentsMap).forEach(([messageId, attachments]) => {
        if (!attachments || attachments.length === 0) {
          return;
        }

        const relevantAttachments = attachments.filter(
          (attachment) => attachment.conversationId === conversationId,
        );

        if (relevantAttachments.length > 0) {
          result[messageId] = relevantAttachments;
        }
      });

      return result;
    },
});

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
  messageAttachmentsMap,
  conversationAttachmentsSelector,
  queriesEnabled,
  showShortcutsDialog,
  keyboardDeleteTarget,
  customShortcuts,
  shortcutsEnabled,
};
