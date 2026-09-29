import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';
import type { Agents } from 'librechat-data-provider';

/**
 * The server-owned pending action for one conversation.
 *
 * Kept outside message rendering so the composer and timeline can project the
 * same action without making mounted cards the source of truth. This state is
 * memory-only: reload hydration comes from the stream status endpoint.
 */
export const pendingApprovalActionFamily = atomFamily((_conversationId: string) =>
  atom<Agents.PendingAction | null>(null),
);
