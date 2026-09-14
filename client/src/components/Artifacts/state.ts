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
