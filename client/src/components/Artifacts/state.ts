import { atom } from 'jotai';

export interface UndockedArtifactsTarget {
  /** The popup hosting the pane. */
  window: Window;
  /** Its portal container, prepared before the pane is handed over. */
  root: HTMLElement;
}

/**
 * Where the artifacts pane currently lives, or `null` while it is docked in
 * the side panel.
 *
 * The prepared container travels with the window so the host can portal into
 * it on its first render: the pane's Recoil-backed registry only survives the
 * move if the new instance mounts in the same commit the docked one unmounts.
 * Clearing this atom is the single instruction to come home.
 */
export const undockedArtifacts = atom<UndockedArtifactsTarget | null>(null);

export const artifactsUndocked = atom((get) => get(undockedArtifacts) != null);

/**
 * Which tab the pane is showing. The pane is a new instance in every host, so
 * a user who undocks while reading code has to arrive in the window on the
 * code tab — with the text they were typing — rather than back on the preview.
 */
export const artifactsActiveTab = atom<string>('preview');

/**
 * Set when the user moves the pane from its own toolbar, either way. That
 * button goes away with the toolbar it lived in, so the pane that takes over
 * has to pick focus up again — a keyboard user would otherwise land on the
 * document of whichever window they were sent to.
 */
export const artifactsPaneFocusRequest = atom(false);
