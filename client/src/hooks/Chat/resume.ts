import { atom } from 'jotai';

/** The latest explicit request to reattach a conversation to its running generation. */
export type ResumeRequest = { conversationId: string; count: number };

/**
 * Explicit requests to reattach a conversation to its running generation (the facade's
 * `resumeStream`). `useResumeOnLoad` answers each new count for the conversation it shows with
 * the same status re-check it runs when a job is announced, so a request never builds a second
 * resume path. One value, not one per conversation: a request only matters to the pane showing
 * that conversation. Chat-owned, so it lives with the chat rather than in the app store.
 */
export const resumeRequestAtom = atom<ResumeRequest>({ conversationId: '', count: 0 });
