import { createContext, useContext, ReactNode, useCallback, useRef } from 'react';

type TCodeBlockContext = {
  getNextIndex: (skip: boolean) => number;
  getNextMermaidIndex: () => number;
  resetCounter: () => void;
};

export const CodeBlockContext = createContext<TCodeBlockContext>({} as TCodeBlockContext);
export const useCodeBlockContext = () => useContext(CodeBlockContext);

export function CodeBlockProvider({
  children,
  baseIndex = 0,
  mermaidBaseIndex = 0,
}: {
  children: ReactNode;
  /**
   * Offset added to every assigned index. When rendering a message as
   * independently memoized blocks, each block gets its own provider seeded with
   * the running count of executable code blocks in earlier blocks, so document-
   * order indices are preserved without a single shared (memoization-fragile)
   * counter.
   */
  baseIndex?: number;
  /**
   * The same offset for mermaid fences, which are skipped by the code-block
   * counter and so need their own sequence to stay distinct from one another.
   */
  mermaidBaseIndex?: number;
}) {
  const counterRef = useRef(0);
  const mermaidCounterRef = useRef(0);

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

  const getNextMermaidIndex = useCallback(() => {
    const nextIndex = mermaidCounterRef.current;
    mermaidCounterRef.current += 1;
    return mermaidBaseIndex + nextIndex;
  }, [mermaidBaseIndex]);

  /* Both counters restart together. A streamed block re-renders its fences on
   * every token, so restarting is what keeps a diagram's index tied to its
   * position in the document instead of drifting upward as the message grows. */
  const resetCounter = useCallback(() => {
    counterRef.current = 0;
    mermaidCounterRef.current = 0;
  }, []);

  return (
    <CodeBlockContext.Provider value={{ getNextIndex, getNextMermaidIndex, resetCounter }}>
      {children}
    </CodeBlockContext.Provider>
  );
}
