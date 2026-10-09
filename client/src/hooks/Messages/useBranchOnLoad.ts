import { useLayoutEffect, useRef } from 'react';
import { useStore } from 'jotai';
import type { TMessage } from 'librechat-data-provider';
import {
  isPersistableConversationId,
  restorePersistedBranch,
  writePersistedBranchTarget,
} from '~/utils/branch';
import { siblingIdxFamily, siblingKey } from '~/components/Chat/Messages/Thread/state';
import { useLatestMessageId } from './useLatestMessage';

/**
 * Persist the viewed branch per conversation and restore it on a normal load.
 * Resume-on-load still owns in-flight generations and overwrites this after.
 */
export default function useBranchOnLoad(
  conversationId: string | undefined,
  getMessages: () => TMessage[] | undefined,
  index = 0,
  messagesLoaded = true,
) {
  const jotaiStore = useStore();
  const tailId = useLatestMessageId(index, conversationId);
  const restoredConvoRef = useRef<string | null>(null);
  const prevConvoRef = useRef<string | undefined>(conversationId);
  const prevTailRef = useRef<string | null>(tailId);

  useLayoutEffect(() => {
    const previousConversationId = prevConvoRef.current;
    const previousTailId = prevTailRef.current;
    if (
      previousConversationId !== conversationId &&
      previousTailId &&
      isPersistableConversationId(previousConversationId)
    ) {
      writePersistedBranchTarget(previousConversationId, previousTailId);
    }

    if (!messagesLoaded || !isPersistableConversationId(conversationId)) {
      prevConvoRef.current = conversationId;
      prevTailRef.current = tailId;
      return;
    }

    if (restoredConvoRef.current !== conversationId) {
      const restoredTarget = restorePersistedBranch(
        getMessages(),
        conversationId,
        (parentMessageId, siblingIdx) => {
          jotaiStore.set(siblingIdxFamily(siblingKey(parentMessageId)), siblingIdx);
        },
      );
      restoredConvoRef.current = conversationId;
      prevConvoRef.current = conversationId;
      prevTailRef.current = restoredTarget ?? tailId;
      return;
    }

    if (tailId) {
      writePersistedBranchTarget(conversationId, tailId);
    }
    prevConvoRef.current = conversationId;
    prevTailRef.current = tailId;
  }, [conversationId, getMessages, jotaiStore, messagesLoaded, tailId]);
}
