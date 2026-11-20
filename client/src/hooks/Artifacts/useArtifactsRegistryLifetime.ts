import { useCallback, useEffect, useRef } from 'react';
import { useSetAtom } from 'jotai';
import { useResetRecoilState } from 'recoil';
import { artifactsActiveTab, artifactsOpenedArtifactId } from '~/components/Artifacts/state';
import store from '~/store';

/**
 * Bounds the artifact registry to one host and one conversation.
 *
 * The identity comes from the host, because which conversation is on screen is
 * the host's question to answer: the chat tab reads its Recoil slot, and a
 * shared conversation has its own id that slot never carries.
 *
 * Wipes `artifactsState` / `currentArtifactId` whenever that identity
 * changes. `useArtifacts` already runs this cleanup, but
 * only while the pane is mounted — so without a top-level guard,
 * tool-artifact cards that self-heal their entries while the panel is
 * closed would leak into the next conversation's panel on open. The
 * matching cards for the new conversation re-register via their own
 * self-heal subscription after this wipe lands.
 *
 * It also wipes on unmount, which is the host leaving: the pane's own cleanup
 * deliberately keeps the registry when it is only changing hosts (side panel,
 * mobile sheet, undocked window), so navigating away from this route — to a
 * shared conversation, say — has to be what clears it.
 */
export default function useArtifactsRegistryLifetime(
  conversationId: string | null | undefined,
): void {
  const resetArtifacts = useResetRecoilState(store.artifactsState);
  const resetCurrentArtifactId = useResetRecoilState(store.currentArtifactId);
  const setActiveTab = useSetAtom(artifactsActiveTab);
  const setOpenedArtifactId = useSetAtom(artifactsOpenedArtifactId);
  const prevConversationIdRef = useRef<string | null>(null);

  /** The pane's view state belongs to the session the registry belongs to. */
  const endSession = useCallback(() => {
    resetArtifacts();
    resetCurrentArtifactId();
    setActiveTab('preview');
    setOpenedArtifactId(null);
  }, [resetArtifacts, resetCurrentArtifactId, setActiveTab, setOpenedArtifactId]);

  useEffect(() => {
    /* An absent id is a host that has nothing to report yet, not a different
     * conversation: a shared link's data can refetch, and the chat tab reads
     * its slot before it is filled. Wiping on the way through would take the
     * registry away from the conversation that owns it and then treat its
     * return as a first sighting, so the last real identity stays the one the
     * next id is compared against. */
    if (conversationId == null) {
      return;
    }
    const prev = prevConversationIdRef.current;
    prevConversationIdRef.current = conversationId;
    if (prev === null || prev === conversationId) {
      return;
    }
    endSession();
  }, [conversationId, endSession]);

  useEffect(() => () => endSession(), [endSession]);
}
