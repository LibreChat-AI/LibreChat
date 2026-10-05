import { atom, getDefaultStore } from 'jotai';
import type { MediaAsset } from 'librechat-data-provider';
import { registerSessionCleanup } from '~/store/session';
export const mediaChatHandoff = atom<{
  scope: string;
  conversationId: string;
  asset: MediaAsset;
} | null>(null);
registerSessionCleanup(() => getDefaultStore().set(mediaChatHandoff, null));
