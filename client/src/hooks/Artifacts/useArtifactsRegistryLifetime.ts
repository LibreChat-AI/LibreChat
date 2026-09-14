import { useCallback, useEffect, useRef } from 'react';
import { useSetAtom } from 'jotai';
import { useRecoilValue, useResetRecoilState } from 'recoil';
import { artifactsActiveTab } from '~/components/Artifacts/state';
import store from '~/store';

/**
 * Bounds the artifact registry to one host and one conversation.
 *
 * Wipes `artifactsState` / `currentArtifactId` whenever the active
 * conversation changes. `useArtifacts` already runs this cleanup, but
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
export default function useArtifactsRegistryLifetime(): void {
  const conversationId = useRecoilValue(store.conversationIdByIndex(0));
  const resetArtifacts = useResetRecoilState(store.artifactsState);
  const resetCurrentArtifactId = useResetRecoilState(store.currentArtifactId);
  const setActiveTab = useSetAtom(artifactsActiveTab);
  const prevConversationIdRef = useRef<string | null>(null);

  /** The pane's view state belongs to the session the registry belongs to. */
  const endSession = useCallback(() => {
    resetArtifacts();
    resetCurrentArtifactId();
    setActiveTab('preview');
  }, [resetArtifacts, resetCurrentArtifactId, setActiveTab]);

  useEffect(() => {
    const prev = prevConversationIdRef.current;
    const next = conversationId ?? null;
    prevConversationIdRef.current = next;
    if (prev == null || prev === next) {
      return;
    }
    endSession();
  }, [conversationId, endSession]);

  useEffect(() => () => endSession(), [endSession]);
}
