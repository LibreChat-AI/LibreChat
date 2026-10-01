import { atom } from 'jotai';

/**
 * Conversations with an unanswered request to reattach to their running generation (the
 * facade's `resumeStream`). The pane showing a conversation consumes its entry and answers it
 * with the same status re-check `useResumeOnLoad` runs when a job is announced, so a request
 * never builds a second resume path. Entries are consumed, so the set stays as small as the
 * requests in flight. Chat-owned, so it lives with the chat rather than in the app store.
 */
export const resumeRequestsAtom = atom<ReadonlySet<string>>(new Set<string>());
