import { memo, useEffect, useLayoutEffect, useRef } from 'react';
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
import useToolArtifactClaim, { isStrictlyNewer } from './claim';
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
 *  1. **Dedup claim** (`useToolArtifactClaim`, via `useLayoutEffect`
 *     inside it, runs synchronously before paint). The same file can
 *     appear in multiple tool calls within a single message (e.g. the
 *     agent reads back what it just wrote) or across messages. The
 *     shared hook scopes the claim to the mounting message (falling
 *     back to the bare artifact id where no message is known), so the
 *     same file shows one card per message instead of one card total.
 *     Within one message the latest card to mount wins, so older
 *     duplicates re-render to `null`.
 *
 *  2. **Self-heal registration** subscribes to the per-id selector
 *     `artifactByIdSelector(artifact.id)` and writes only when the
 *     entry is missing or the cached content/type/title drifted AND
 *     this card's version is at least as new (`lastUpdateTime`). The
 *     panel's `useArtifacts` hook resets `artifactsState` on close, so
 *     this re-fires deterministically once the slice transitions back
 *     to `undefined` — without the no-deps render-loop pattern. A
 *     strictly newer version always wins regardless of mount order;
 *     when two versions share a `lastUpdateTime` (no timestamp signal),
 *     the tie breaks on a SEPARATE global "latest mount" claim kept
 *     only for this purpose — today's semantics, scoped to the id alone
 *     so it survives across messages. That single-writer tie-break is
 *     what stops two cards for the same file from observing each
 *     other's write and trading overwrites in a loop.
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
  const file = attachment as TFile & TAttachmentMetadata;
  const fileId = file.file_id;
  const setVisible = useSetRecoilState(store.artifactsVisibility);
  const setArtifacts = useSetRecoilState(store.artifactsState);
  const setCurrentArtifactId = useSetRecoilState(store.currentArtifactId);
  const resetCurrentArtifactId = useResetRecoilState(store.currentArtifactId);
  const currentArtifactId = useRecoilValue(store.currentArtifactId);
  const existingEntry = useRecoilValue(store.artifactByIdSelector(artifact.id));
  const { isMyClaim: canRender, claimKey } = useToolArtifactClaim(artifact.id);
  // Global (message-independent) claim — used only as the registration
  // tie-break below, never for the render-null gate. Reuses the same
  // `claimKey` as the display claim above so the two never fight over the
  // SAME atom entry in the no-message fallback, where both keys collapse
  // to `store.toolArtifactClaim(artifact.id)`.
  const [globalClaim, setGlobalClaim] = useRecoilState(store.toolArtifactClaim(artifact.id));
  const isMyGlobalClaim = globalClaim === claimKey;
  const isSelected = artifact.id === currentArtifactId;
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
    // Always (re)claim the global slot on mount — keeps today's
    // latest-mount semantics as the tie-break input for the registration
    // effect below, independent of which message a card renders under.
    setGlobalClaim(claimKey);
    return () => {
      // Only release when the claim is still ours; if a sibling already
      // took over we don't want to clobber its claim.
      setGlobalClaim((prev) => (prev === claimKey ? null : prev));
    };
  }, [claimKey, setGlobalClaim]);

  useEffect(() => {
    const contentDrifted = !(
      existingEntry != null &&
      existingEntry.content === artifact.content &&
      existingEntry.type === artifact.type &&
      existingEntry.title === artifact.title
    );
    if (!contentDrifted) {
      return;
    }
    // A strictly newer version always wins, regardless of mount order.
    // When two versions share a `lastUpdateTime` (no timestamp signal to
    // order them), fall back to the global "latest mount" claim so a
    // ping-ponging pair still converges on ONE writer instead of trading
    // overwrites in a loop.
    const isNewerOrTied =
      existingEntry == null ||
      isStrictlyNewer(artifact, existingEntry) ||
      (artifact.lastUpdateTime === existingEntry.lastUpdateTime && isMyGlobalClaim);
    if (!isNewerOrTied) {
      return;
    }
    setArtifacts((prev) => ({ ...(prev ?? {}), [artifact.id]: artifact }));
  }, [artifact, existingEntry, isMyGlobalClaim, setArtifacts]);

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

  // Another card holds the message-scoped display claim for this file —
  // render nothing here, that row is the canonical trigger for this file.
  if (!canRender) {
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
