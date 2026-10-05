import { atom } from 'jotai';

export type ArtifactNavigationRequest = {
  conversationId: string;
  sourceKey: string;
  originalArtifactId?: string;
  messageId?: string;
};

/** Durable handoff from the artifact catalog to a hydrating conversation route. */
export const artifactNavigationRequestAtom = atom<ArtifactNavigationRequest | null>(null);
