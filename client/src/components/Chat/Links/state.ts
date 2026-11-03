import { atom } from 'jotai';

/**
 * The conversation whose links panel is open, or null when closed. Keyed by
 * conversation so navigating away closes the panel and returning reopens it,
 * the same lifetime the trace viewer keeps.
 */
export const linksPanelConversationAtom = atom<string | null>(null);
