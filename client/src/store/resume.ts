import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';

/**
 * Counts explicit requests to reattach a conversation to its running generation (the facade's
 * `resumeStream`). `useResumeOnLoad` answers each increase with the same status re-check it runs
 * when a job is announced, so a request never builds a second resume path.
 */
export const resumeRequestFamily = atomFamily((_conversationId: string) => atom<number>(0));
