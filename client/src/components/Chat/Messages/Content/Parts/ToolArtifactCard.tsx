import { memo, useEffect, useId, useLayoutEffect, useRef } from 'react';
import {
  useRecoilCallback,
  useRecoilState,
  useRecoilValue,
  useResetRecoilState,
  useSetRecoilState,
} from 'recoil';
import type { TAttachment, TFile, TAttachmentMetadata } from 'librechat-data-provider';
import type { Artifact } from '~/common';
import { artifactRowKind, isCodeOnlyArtifact } from '~/utils/artifacts';
import { displayFilename } from './attachmentTypes';
import { useAttachmentLink } from './LogLink';
import ArtifactRow from './ArtifactRow';
import store from '~/store';

interface ToolArtifactCardProps {
  attachment: TAttachment;
  artifact: Artifact;
}

/**
 * Card that opens a code-execution-produced artifact in the side panel.
 *
 * Three effects, separately scoped:
 *
 *  1. **Dedup claim** (`useLayoutEffect`, runs synchronously before
 *     paint). The same file can appear in multiple tool calls within a
 *     single message (e.g. the agent reads back what it just wrote) or
 *     across messages. Each card claims `toolArtifactClaim(artifact.id)`
 *     with its unique component-instance key on mount; the latest card
 *     to mount wins, so older duplicates re-render to `null`. The atom
 *     is family-keyed by artifact id, so claims for unrelated artifacts
 *     don't trigger re-renders here. Cleanup releases the claim if it's
 *     still ours so a subsequent re-mount can take it.
 *
 *  2. **Self-heal registration** subscribes to the per-id selector
 *     `artifactByIdSelector(artifact.id)` and writes only when the
 *     entry is missing or the cached content/type/title drifted. The
 *     panel's `useArtifacts` hook resets `artifactsState` on close, so
 *     this re-fires deterministically once the slice transitions back
 *     to `undefined` — without the no-deps render-loop pattern. The
 *     write is also gated on `isMyClaim`, making the registration
 *     single-writer per id: when two cards exist for the same file
 *     across turns, only the latest (claim-holder) updates state.
 *     Without that guard, both cards would observe each other's write
 *     and trade overwrites in a loop.
 *
 *  3. **Focus + open on mount** (deps: artifact.id, artifact.type) —
 *     gated on `isSubmitting` captured at first render via a ref AND
 *     on `artifact.type !== CODE`. A card mounted *during* streaming
 *     for a rich-preview bucket (HTML, React, Markdown, plain text)
 *     steals panel focus and forces `artifactsVisibility = true` so
 *     the panel auto-opens — matching the legacy SSE auto-open UX.
 *     A card mounted while `isSubmitting === false` is part of
 *     conversation history (page load, back-navigation) and must not
 *     steal focus — `Presentation`'s render condition gates on
 *     `currentArtifactId != null`, so leaving both alone keeps the
 *     panel closed on history load. The CODE bucket (`.py`, `.js`,
 *     `Dockerfile`, …) is click-to-open *even on streaming*: source
 *     files are typically supporting scripts the agent emits alongside
 *     a richer deliverable, and shoving the panel in front of the
 *     user every time a helper script gets written is disruptive.
 *     Click-to-open via `handleOpen` works for every bucket regardless
 *     of context.
 */
const ToolArtifactCard = memo(({ attachment, artifact }: ToolArtifactCardProps) => {
  const claimKey = useId();
  const file = attachment as TFile & TAttachmentMetadata;
  const fileId = file.file_id;
  const setVisible = useSetRecoilState(store.artifactsVisibility);
  const setArtifacts = useSetRecoilState(store.artifactsState);
  const setCurrentArtifactId = useSetRecoilState(store.currentArtifactId);
  const resetCurrentArtifactId = useResetRecoilState(store.currentArtifactId);
  const currentArtifactId = useRecoilValue(store.currentArtifactId);
  const existingEntry = useRecoilValue(store.artifactByIdSelector(artifact.id));
  const [claim, setClaim] = useRecoilState(store.toolArtifactClaim(artifact.id));
  const isSelected = artifact.id === currentArtifactId;
  const isMyClaim = claim === claimKey;
  /* Read+reset on mount only — `useRecoilCallback` avoids subscribing
   * to the per-file_id flag (no re-renders when other files resolve).
   * The deferred-preview hook flips this to `true` on the pending→ready
   * edge; we consume it once and reset, so repeat mounts (panel close
   * then reopen, history scroll) don't auto-open a second time. */
  const consumeJustResolved = useRecoilCallback(
    ({ snapshot, reset }) =>
      (id: string) => {
        const flagged = snapshot.getLoadable(store.previewJustResolved(id)).valueMaybe() ?? false;
        if (flagged) {
          reset(store.previewJustResolved(id));
        }
        return flagged;
      },
    [],
  );
  /**
   * Captured at first render via a non-subscribing snapshot read so the
   * downstream effect doesn't re-fire (and the component doesn't
   * re-render) every time `isSubmittingFamily(0)` flips. Cards that mount
   * mid-stream stay "fresh" for the rest of their lifetime; cards that
   * mount post-stream stay "history" even if the user sends a new
   * message while this card stays mounted.
   */
  const readInitialIsSubmitting = useRecoilCallback(
    ({ snapshot }) =>
      () =>
        // `valueMaybe()` returns `undefined` if the atom is in an error
        // or loading state instead of throwing — defensive against an
        // upstream selector failure surfacing during card mount. The
        // `?? false` default is correct because a card we can't classify
        // as streaming is one we should treat as history (don't steal
        // focus / open the panel).
        snapshot.getLoadable(store.isSubmittingFamily(0)).valueMaybe() ?? false,
    [],
  );
  const mountedDuringStreamRef = useRef<boolean | null>(null);
  if (mountedDuringStreamRef.current === null) {
    mountedDuringStreamRef.current = readInitialIsSubmitting();
  }

  useLayoutEffect(() => {
    // Always (re)claim on mount — a later card for the same id displaces
    // an earlier one, so the chip migrates to the most recent mention.
    setClaim(claimKey);
    return () => {
      // Only release when the claim is still ours; if a sibling already
      // took over we don't want to clobber its claim.
      setClaim((prev) => (prev === claimKey ? null : prev));
    };
  }, [claimKey, setClaim]);

  useEffect(() => {
    // Only the claim-winner writes. Two cards with the same `artifact.id`
    // but divergent content (same file_id reused across turns) would
    // otherwise see each other's write through `existingEntry`, detect
    // drift, and trade overwrites in a loop. Gating on `isMyClaim`
    // makes registration single-writer per id.
    if (!isMyClaim) {
      return;
    }
    if (
      existingEntry != null &&
      existingEntry.content === artifact.content &&
      existingEntry.type === artifact.type &&
      existingEntry.title === artifact.title
    ) {
      return;
    }
    setArtifacts((prev) => ({ ...(prev ?? {}), [artifact.id]: artifact }));
  }, [artifact, existingEntry, isMyClaim, setArtifacts]);

  useEffect(() => {
    if (isCodeOnlyArtifact(artifact.type)) {
      // Source-code artifacts (`.py`, `.js`, `.cpp`, `Dockerfile`, …) are
      // click-to-open only. They're typically supporting scripts the
      // agent emits alongside a richer deliverable; auto-opening them
      // would shove the panel in front of the user every time a tool
      // call writes a helper file. The rich-preview buckets (HTML,
      // React, Markdown, plain text) keep the legacy auto-open UX so
      // an HTML deliverable still surfaces immediately.
      return;
    }
    /* Two paths qualify the card for auto-open:
     *   1. Streaming-time mount — ref captured `isSubmitting === true`
     *      at first render. The card is part of the live response, so
     *      the legacy "panel pops open as artifacts arrive" UX applies.
     *   2. Just-resolved deferred preview — `useAttachmentPreviewSync`
     *      sets a one-shot flag on the pending→ready edge. The
     *      deferred render can complete *after* the SSE stream closes,
     *      so checking only `isSubmitting` would miss this case (the
     *      chip would render in place but never auto-open). Consuming
     *      the flag also resets it, so subsequent re-mounts (panel
     *      close/reopen, history scroll) do not re-steal focus.
     * History mounts (file already resolved on page load) hit neither
     * path, so the panel stays closed on navigation — no jarring
     * auto-open just from scrolling past an old artifact. */
    const justResolved = fileId ? consumeJustResolved(fileId) : false;
    if (!mountedDuringStreamRef.current && !justResolved) {
      return;
    }
    // Streaming arrival or just-resolved preview: focus the new artifact
    // AND force the panel visible. Without `setVisible(true)`, a session
    // where the user had previously closed the panel (visibility=false)
    // would surface the selection in the chip ("click to close") but
    // never actually open — `Presentation` gates rendering on visibility.
    setCurrentArtifactId(artifact.id);
    setVisible(true);
  }, [artifact.id, artifact.type, fileId, consumeJustResolved, setCurrentArtifactId, setVisible]);

  const { handleDownload } = useAttachmentLink({
    href: attachment.filepath ?? '',
    filename: attachment.filename ?? '',
    file_id: file.file_id,
    user: file.user,
    source: file.source,
  });

  const handleOpen = () => {
    if (isSelected) {
      resetCurrentArtifactId();
      setVisible(false);
      return;
    }
    // Registration already happened in the mount effect; the click only
    // needs to focus + reveal the panel for users who have closed it.
    setCurrentArtifactId(artifact.id);
    setVisible(true);
  };

  // Another card with the same artifact id has the active claim — render
  // nothing here, that row is the canonical trigger for this file.
  if (claim != null && !isMyClaim) {
    return null;
  }

  // The artifact's stored `title` mirrors the on-disk `filename` for
  // tool artifacts, so re-derive the user-facing label rather than
  // showing the collision-suffixed name.
  const visibleTitle = displayFilename(artifact.title);

  return (
    <ArtifactRow
      title={visibleTitle}
      kind={artifactRowKind(artifact)}
      isSelected={isSelected}
      onOpen={handleOpen}
      onDownload={handleDownload}
      artifactId={artifact.id}
    />
  );
});

ToolArtifactCard.displayName = 'ToolArtifactCard';

export default ToolArtifactCard;
