import { atom, selectorFamily } from 'recoil';
import { TAttachment } from 'librechat-data-provider';
import { atomWithLocalStorage } from './utils';
import { BadgeItem } from '~/common';

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

const isEditingBadges = atom<boolean>({
  key: 'isEditingBadges',
  default: false,
});

const showShortcutsDialog = atom<boolean>({
  key: 'showShortcutsDialog',
  default: false,
});

/** The file manager is a dialog reached from the account menu rather than a
 *  side panel, so the shortcut that opens it needs a way in from anywhere. */
const showFilesDialog = atom<boolean>({
  key: 'showFilesDialog',
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

const chatBadges = atomWithLocalStorage<Pick<BadgeItem, 'id'>[]>('chatBadges', [
  // When adding new badges, make sure to add them to useChatBadges.ts as well and add them as last item
  // DO NOT CHANGE THE ORDER OF THE BADGES ALREADY IN THE ARRAY
  { id: '1' },
  // { id: '2' },
]);

export default {
  hideBannerHint,
  messageAttachmentsMap,
  conversationAttachmentsSelector,
  queriesEnabled,
  isEditingBadges,
  showShortcutsDialog,
  showFilesDialog,
  keyboardDeleteTarget,
  customShortcuts,
  shortcutsEnabled,
  chatBadges,
};
