import { useId, useLayoutEffect } from 'react';
import { useRecoilState } from 'recoil';
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
 * the same file shows one card per message (FR-06) but collapses repeat
 * mounts within a single message to one (FR-07). Falls back to the bare
 * file id when no message is known (search/shared views without an
 * ambient `MessageContext`), which keeps today's cross-message dedup for
 * that caller — `ArtifactRouting.test.tsx`'s "latest mount wins" and
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
