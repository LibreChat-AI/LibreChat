import { useId, useLayoutEffect } from 'react';
import { atom } from 'jotai';
import { useRecoilState } from 'recoil';
import { atomFamily } from 'jotai/utils';
import type { Artifact } from '~/common';
import { useMessageContext } from '~/Providers';
import store from '~/store';

interface ToolArtifactClaim {
  /** False only while another mounted instance holds this display key. */
  isMyClaim: boolean;
  /**
   * This instance's stable claim key. `ToolArtifactCard` reuses it to also
   * claim the id-only (message-independent) `toolArtifactClaim(id)` atom for
   * its registration tie-break, so that claim and this hook's display claim
   * never fight over the SAME atom entry in the no-message fallback, where
   * both keys collapse to the bare `id`.
   */
  claimKey: string;
}

/**
 * Scopes a tool artifact's chat-row dedup to the message that mounts it, so
 * the same file shows one card per message but collapses repeat
 * mounts within a single message to one. Falls back to the bare
 * file id when no message is known — only the search-results route
 * (`routes/Search.tsx` → `SearchMessage`) renders without an ambient
 * `MessageContext`; `Share/Message.tsx` already provides one with
 * `messageId` set. That fallback keeps today's cross-message dedup for
 * the search route — `ArtifactRouting.test.tsx`'s "latest mount wins" and
 * "does not ping-pong" cases render this way and must stay green.
 *
 * Shared by `ToolArtifactCard` and `ToolMermaidArtifact` so the same file
 * dedups identically whether it renders as a panel card or an inline
 * diagram.
 */
export default function useToolArtifactClaim(id: string): ToolArtifactClaim {
  const claimKey = useId();
  const { messageId } = useMessageContext();
  const displayKey = messageId ? `${messageId}::${id}` : id;
  const [claim, setClaim] = useRecoilState(store.toolArtifactClaim(displayKey));

  useLayoutEffect(() => {
    // Always (re)claim on mount — a later card for the same key displaces
    // an earlier one, so the chip migrates to the most recent mention.
    setClaim(claimKey);
    return () => {
      // Only release when the claim is still ours; if a sibling already
      // took over we don't want to clobber its claim.
      setClaim((prev) => (prev === claimKey ? null : prev));
    };
  }, [claimKey, setClaim]);

  return { isMyClaim: claim == null || claim === claimKey, claimKey };
}

/**
 * Per-file-identity "newest version seen" for tool-diagram artifacts.
 * Every mounted `ToolMermaidArtifact` offers its own artifact here on
 * mount, keeping whichever entry has the larger `lastUpdateTime` (ties
 * keep the current entry, so equal-time offers don't drift). Entries
 * persist after a card unmounts, so a message whose diagram was
 * superseded stays discoverable for any other message sharing the same
 * file identity even after the newer card leaves the DOM.
 */
export const newestToolArtifactFamily = atomFamily((_id: string) => atom<Artifact | null>(null));

/**
 * Shared by `ToolArtifactCard`'s self-heal registration and
 * `ToolMermaidArtifact`/`Mermaid`'s newest-version handling so both use
 * the same "is `candidate` strictly newer than `other`" rule instead of
 * two copies that could drift out of sync.
 */
export function isStrictlyNewer(
  candidate: Pick<Artifact, 'lastUpdateTime'>,
  other: Pick<Artifact, 'lastUpdateTime'> | null | undefined,
): boolean {
  return other != null && candidate.lastUpdateTime > other.lastUpdateTime;
}
