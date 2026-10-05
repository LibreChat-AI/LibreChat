import type { MediaAsset } from 'librechat-data-provider';
import type { useStore } from 'jotai';
import type { MediaDraft } from './state';
import { mediaDraftFamily, mediaLibraryFamily } from './state';

/** Seed an explicit edit while preserving the user's prompt and generation preferences. */
export function seedMediaEditDraft(previous: MediaDraft, assets: MediaAsset[]): MediaDraft {
  return {
    ...previous,
    revision: previous.revision + 1,
    operation: 'image.edit',
    autoEdit: false,
    parentTurnId: undefined,
    assets,
    inputs: assets.map((asset) => ({ role: 'reference', file_id: asset.file_id })),
  };
}

/** Seeds the new-creation editor and shows it, even when Studio last showed the gallery. */
export function openMediaEditDraft(
  store: ReturnType<typeof useStore>,
  scope: string,
  assets: MediaAsset[],
): void {
  store.set(mediaDraftFamily(`${scope}:new`), (previous) => seedMediaEditDraft(previous, assets));
  store.set(mediaLibraryFamily(scope), (previous) => ({ ...previous, view: 'thread' }));
}
