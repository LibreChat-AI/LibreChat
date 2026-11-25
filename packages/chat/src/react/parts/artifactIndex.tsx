import { createContext, useContext, useCallback, useRef } from 'react';
import type { Context, ReactNode } from 'react';

/** Hands the artifacts of one rendered markdown tree their position in document order. */
export type ArtifactIndex = {
  getNextIndex: (skip: boolean) => number;
  resetCounter: () => void;
  /** Whether new tokens can still extend the tree's last line. */
  provisionalEnd: boolean;
};

export const ArtifactContext: Context<ArtifactIndex> = createContext<ArtifactIndex>(
  {} as ArtifactIndex,
);
export const useArtifactContext = (): ArtifactIndex => useContext(ArtifactContext);

export function ArtifactProvider({
  children,
  baseIndex = 0,
  provisionalEnd = false,
}: {
  children: ReactNode;
  /**
   * Offset added to every assigned index, so per-block memoized rendering can
   * seed each block's provider with the count of artifacts in earlier blocks
   * and keep document-order indices stable.
   */
  baseIndex?: number;
  provisionalEnd?: boolean;
}): ReactNode {
  const counterRef = useRef(0);

  const getNextIndex = useCallback(
    (skip: boolean) => {
      if (skip) {
        return baseIndex + counterRef.current;
      }
      const nextIndex = counterRef.current;
      counterRef.current += 1;
      return baseIndex + nextIndex;
    },
    [baseIndex],
  );

  const resetCounter = useCallback(() => {
    counterRef.current = 0;
  }, []);

  return (
    <ArtifactContext.Provider value={{ getNextIndex, resetCounter, provisionalEnd }}>
      {children}
    </ArtifactContext.Provider>
  );
}
