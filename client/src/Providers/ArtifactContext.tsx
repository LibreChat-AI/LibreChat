import { createContext, useContext, ReactNode, useCallback, useRef } from 'react';

type TArtifactContext = {
  getNextIndex: (skip: boolean) => number;
  resetCounter: () => void;
};

export const ArtifactContext = createContext<TArtifactContext>({} as TArtifactContext);
export const useArtifactContext = () => useContext(ArtifactContext);

export function ArtifactProvider({
  children,
  baseIndex = 0,
}: {
  children: ReactNode;
  /**
   * Offset added to every assigned index, so per-block memoized rendering can
   * seed each block's provider with the count of artifacts in earlier blocks
   * and keep document-order indices stable.
   */
  baseIndex?: number;
}) {
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
    <ArtifactContext.Provider value={{ getNextIndex, resetCounter }}>
      {children}
    </ArtifactContext.Provider>
  );
}
