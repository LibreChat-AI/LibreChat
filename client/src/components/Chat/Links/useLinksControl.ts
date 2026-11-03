import { useCallback } from 'react';
import { useAtom } from 'jotai';
import { Constants } from 'librechat-data-provider';
import { linksPanelConversationAtom } from './state';

const UNPERSISTED_IDS = new Set(
  [Constants.NEW_CONVO, Constants.PENDING_CONVO, Constants.SEARCH].map(String),
);

export type LinksControl = {
  /** A persisted conversation the panel can describe. */
  show: boolean;
  isOpen: boolean;
  toggle: () => void;
};

/**
 * The links panel entry point for the header button. The panel itself lives in
 * the side-panel slot, so opening it only sets which conversation it belongs to.
 */
export default function useLinksControl({
  conversationId,
}: {
  conversationId?: string | null;
}): LinksControl {
  const [linksConversationId, setLinksConversationId] = useAtom(linksPanelConversationAtom);
  const persisted = conversationId != null && !UNPERSISTED_IDS.has(conversationId);
  const isOpen = persisted && linksConversationId === conversationId;

  const toggle = useCallback(() => {
    setLinksConversationId((current) =>
      current === conversationId ? null : (conversationId ?? null),
    );
  }, [conversationId, setLinksConversationId]);

  return { show: persisted, isOpen, toggle };
}
