import { Constants } from 'librechat-data-provider';
import type { TConversation } from 'librechat-data-provider';
import type { StartGenerationResult } from './start';
import type { MountContext } from './host';
import { isInitialNewConversation, keepLocalCodeApprovalMode } from './messages';
import { toStartGenerationError } from './start';

/**
 * The server reports the turn already settled (a duplicate start of a finished generation).
 * Adopts the persisted conversation, refreshes history, and ends the run without attaching.
 */
export async function settleStart(
  mount: MountContext,
  startResult: Extract<StartGenerationResult, { status: 'settled' }>,
): Promise<void> {
  const { run, host, submission, isCurrent } = mount;
  const settledConversationId = startResult.conversationId;
  const startedAsNewConvo = isInitialNewConversation(submission);
  let persistedConversation: TConversation | undefined;
  let conversationLookup: 'found' | 'not_found' | 'inconclusive' = 'inconclusive';
  try {
    persistedConversation = await host.cache.fetchConversation(settledConversationId);
    if (!isCurrent()) {
      return;
    }
    conversationLookup = 'found';
  } catch (error) {
    if (!isCurrent()) {
      return;
    }
    conversationLookup =
      toStartGenerationError(error)?.response?.status === 404 ? 'not_found' : 'inconclusive';
    host.logger.warn('ResumableSSE', 'Could not load settled generation conversation', {
      conversationId: settledConversationId,
      conversationLookup,
      error,
    });
  }

  if (persistedConversation != null) {
    /** The persisted copy carries the mode the settled turn started
     *  with; a pick made while the start was pending is newer. The
     *  live conversation still holds the new-chat id here because no
     *  stream event ran for this turn. */
    const settledCopy = persistedConversation;
    const localConversationId = startedAsNewConvo ? Constants.NEW_CONVO : settledConversationId;
    const conversationRecord = keepLocalCodeApprovalMode(
      settledCopy,
      host.cache.getConversation(settledConversationId),
      settledConversationId,
    );
    host.cache.setConversation(settledConversationId, conversationRecord);
    host.cache.upsertConversation(conversationRecord);
    host.pane.setConversation?.((current) =>
      keepLocalCodeApprovalMode(settledCopy, current, localConversationId),
    );
    if (startedAsNewConvo) {
      host.pane.replaceNewConversationUrl(settledConversationId);
    }
  }

  try {
    await host.cache.invalidateMessages(settledConversationId, 'all');
    if (!isCurrent()) {
      return;
    }
    await host.cache.refreshConversation(settledConversationId);
    if (!isCurrent()) {
      return;
    }
    await host.cache.refreshConversationLists();
    if (!isCurrent()) {
      return;
    }
    await host.cache.refreshPinnedConversations();
    if (!isCurrent()) {
      return;
    }
  } catch (error) {
    if (!isCurrent()) {
      return;
    }
    host.logger.warn('ResumableSSE', 'Could not refresh settled generation history', {
      conversationId: settledConversationId,
      error,
    });
  }

  if (conversationLookup === 'not_found' && startedAsNewConvo) {
    /** A failed/early-aborted first turn can settle without ever
     * creating a conversation. Never mint A's optimistic rows here:
     * prune any partial cache and return to `/c/new` instead of
     * leaving a phantom chat/URL. */
    host.cache.removeConversation(settledConversationId);
    host.cache.removeConversationQueries(settledConversationId);
    host.pane.startNewConversation?.();
  }
  if (conversationLookup === 'inconclusive') {
    /** A network/5xx lookup cannot prove the conversation is absent.
     * Preserve its optimistic/cache state for a later refetch and do
     * not navigate or mint a fresh `/c/new` conversation. */
    host.pane.clearDrainAfterAbort(settledConversationId, submission.expectedPredecessorCreatedAt);
  }
  host.events.clearStepMaps();
  host.pane.setIsSubmitting(false);
  host.pane.setShowStopButton(false);
  host.pane.publishRunEnd({
    conversationId: settledConversationId,
    outcome: conversationLookup === 'inconclusive' ? 'error' : 'aborted',
    startedAsNewConvo,
    endedAt: run.scheduler.now(),
  });
  host.pane.setSubmission(null);
}
