import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';
import type { ExtendedFile } from '@librechat/chat';

/**
 * Files staged for a conversation in a composer the reader is leaving, for the composer that
 * conversation opens under as the page's main chat. In memory, like the text handed over the
 * same way, so they arrive whatever the Save Drafts preference is. Taken once, by main chat's
 * composer, when it holds that conversation.
 */
export const handedComposerFilesFamily = atomFamily((_conversationId: string) =>
  atom<Map<string, ExtendedFile> | null>(null),
);

/**
 * What of a composer's staged files can go with its conversation: the ones whose upload has
 * finished. One still on its way reports to the composer that started it, which is going away,
 * so its record would never complete in another and would hold that composer's send back.
 */
export const stagedForHandoff = (files: Map<string, ExtendedFile>): Map<string, ExtendedFile> =>
  new Map([...files].filter(([, file]) => file.progress >= 1));
