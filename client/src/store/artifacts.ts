import { atom, atomFamily, selectorFamily } from 'recoil';
import type { Artifact } from '~/common';
import { logger } from '~/utils';

export const artifactsState = atom<Record<string, Artifact | undefined> | null>({
  key: 'artifactsState',
  default: null,
  effects: [
    ({ onSet, node }) => {
      onSet(async (newValue) => {
        logger.log('artifacts', 'Recoil Effect: Setting artifactsState', {
          key: node.key,
          newValue,
        });
      });
    },
  ] as const,
});

export const currentArtifactId = atom<string | null>({
  key: 'currentArtifactId',
  default: null,
  effects: [
    ({ onSet, node }) => {
      onSet(async (newValue) => {
        logger.log('artifacts', 'Recoil Effect: Setting currentArtifactId', {
          key: node.key,
          newValue,
        });
      });
    },
  ] as const,
});

export const artifactsVisibility = atom<boolean>({
  key: 'artifactsVisibility',
  default: true,
  effects: [
    ({ onSet, node }) => {
      onSet(async (newValue) => {
        logger.log('artifacts', 'Recoil Effect: Setting artifactsVisibility', {
          key: node.key,
          newValue,
        });
      });
    },
  ] as const,
});

/**
 * Per-artifact-id claim used by `ToolArtifactCard` to dedup the same file
 * across tool calls / messages. Holds the unique component-instance key
 * of whichever card most recently mounted for that id; cards whose key
 * doesn't match return `null` so the same chip doesn't render twice.
 *
 * Keyed by `artifact.id` (which is `tool-artifact-${file_id}`), so each
 * card subscribes only to its own slice — adding or removing a claim
 * for one artifact never re-renders cards for unrelated artifacts.
 *
 * Lifetime: atom entries remain in the family map even after a card
 * unmounts (Recoil doesn't GC `atomFamily` entries). Card unmount
 * resets the value to `null`, so the residual cost per artifact is one
 * key + a `null` value — negligible at typical session scale (dozens
 * of files per conversation). If this ever becomes a memory concern
 * we can fold the family into a single `Record` atom and reset it from
 * `useArtifacts`'s conversation-change cleanup.
 */
export const toolArtifactClaim = atomFamily<string | null, string>({
  key: 'toolArtifactClaim',
  default: null,
});

/**
 * Per-artifact-id slice of `artifactsState`. Used by `ToolArtifactCard`
 * for self-heal registration: the card subscribes only to its own
 * entry, so the registration effect re-runs deterministically when the
 * entry is wiped (e.g. by `useArtifacts`'s panel-unmount cleanup) or
 * when the artifact's content meaningfully changes — instead of firing
 * on every parent render via a no-deps `useEffect`.
 */
export const artifactByIdSelector = selectorFamily<Artifact | undefined, string>({
  key: 'artifactById',
  get:
    (artifactId) =>
    ({ get }) => {
      const artifacts = get(artifactsState);
      return artifacts?.[artifactId];
    },
});

/**
 * One-shot signal that an attachment's deferred preview just transitioned
 * from `pending` to `ready` during the current session — keyed by
 * `[messageId, file_id]`. The same file can appear in more than one response;
 * a historical card must not consume a live response's pending signal.
 *
 * The preview-sync hook flips this to `true` on the pending→ready edge.
 * `ToolArtifactCard` reads it for the same owning message; if set, it
 * auto-opens the panel (even when no submission is in flight) and then
 * resets the flag, so later mounts of that response do not steal focus.
 *
 * Why a separate signal rather than reusing `mountedDuringStreamRef`:
 * the deferred render can complete *after* the SSE stream has closed,
 * so the card mounts with `isSubmitting === false` and the existing
 * focus/open path skips. Without this signal, a freshly resolved
 * artifact would render in place but not auto-open — which is exactly
 * the bug the deferred-preview flow was designed to mask in the first
 * place. Auto-open ONLY on the pending→ready edge means a user
 * scrolling through history doesn't get the panel popping open every
 * time a previously resolved chip enters the viewport.
 */
export const previewJustResolved = atomFamily<boolean, [messageId: string, fileId: string]>({
  key: 'previewJustResolved',
  default: false,
});

export const visibleArtifacts = atom<Record<string, Artifact | undefined> | null>({
  key: 'visibleArtifacts',
  default: null,
  effects: [
    ({ onSet, node }) => {
      onSet(async (newValue) => {
        logger.log('artifacts', 'Recoil Effect: Setting `visibleArtifacts`', {
          key: node.key,
          newValue,
        });
      });
    },
  ] as const,
});
