import React, { createContext, useContext, useState, useMemo, useCallback, useRef } from 'react';

/**
 * Mutation state context - for components that need to know about save/edit status
 * Separated from code state to prevent unnecessary re-renders
 */
interface MutationContextType {
  isMutating: boolean;
  setIsMutating: React.Dispatch<React.SetStateAction<boolean>>;
}

/**
 * Code state context - for components that need the current code content
 * Changes frequently (on every keystroke), so only subscribe if needed.
 *
 * The buffer carries the artifact it belongs to. The pane is remounted when it
 * changes hosts (side panel, mobile sheet, undocked window), so whether the
 * buffer is this artifact's unsaved text cannot be decided from a mount.
 *
 * `codeSession` is the editing session the buffer belongs to. A save keeps its
 * callbacks after the editor that started it is gone, and those callbacks
 * would otherwise write the buffer a closed session just cleared and submit
 * its queued edit — so they compare the session they were started in against
 * this live counter. It is a mutable object rather than a value because the
 * comparison happens after the reader's last render.
 *
 * Ending a session also releases the save lock it took: the request that took
 * it is no longer anyone's to wait for, and its callbacks leave the lock alone
 * precisely because it now belongs to the next session.
 */
interface CodeContextType {
  currentCode?: string;
  codeArtifactId?: string;
  setCurrentCode: (code: string | undefined, artifactId?: string) => void;
  codeSession: { current: number };
  endCodeSession: () => void;
}

const MutationContext = createContext<MutationContextType | undefined>(undefined);
const CodeContext = createContext<CodeContextType | undefined>(undefined);

/**
 * Provides editor state management for artifact code editing
 * Split into two contexts to prevent unnecessary re-renders:
 * - MutationContext: for save/edit status (changes rarely)
 * - CodeContext: for code content (changes on every keystroke)
 */
export function EditorProvider({ children }: { children: React.ReactNode }) {
  const [isMutating, setIsMutating] = useState(false);
  const [codeBuffer, setCodeBuffer] = useState<{ code?: string; artifactId?: string }>({});
  const codeSession = useRef(0);

  const setCurrentCode = useCallback((code: string | undefined, artifactId?: string) => {
    setCodeBuffer((previous) => ({
      code,
      artifactId: artifactId ?? (code === undefined ? undefined : previous.artifactId),
    }));
  }, []);

  const endCodeSession = useCallback(() => {
    codeSession.current += 1;
    setCodeBuffer({});
    setIsMutating(false);
  }, []);

  const mutationValue = useMemo(() => ({ isMutating, setIsMutating }), [isMutating]);
  const codeValue = useMemo(
    () => ({
      currentCode: codeBuffer.code,
      codeArtifactId: codeBuffer.artifactId,
      setCurrentCode,
      codeSession,
      endCodeSession,
    }),
    [codeBuffer, endCodeSession, setCurrentCode],
  );

  return (
    <MutationContext.Provider value={mutationValue}>
      <CodeContext.Provider value={codeValue}>{children}</CodeContext.Provider>
    </MutationContext.Provider>
  );
}

/**
 * Hook to access mutation state only
 * Use this when you only need to know about save/edit status
 */
export function useMutationState() {
  const context = useContext(MutationContext);
  if (context === undefined) {
    throw new Error('useMutationState must be used within an EditorProvider');
  }
  return context;
}

/**
 * Hook to access code state only
 * Use this when you need the current code content
 */
export function useCodeState() {
  const context = useContext(CodeContext);
  if (context === undefined) {
    throw new Error('useCodeState must be used within an EditorProvider');
  }
  return context;
}

/**
 * @deprecated Use useMutationState() and/or useCodeState() instead
 * This hook causes components to re-render on every keystroke
 */
export function useEditorContext() {
  const mutation = useMutationState();
  const code = useCodeState();
  return { ...mutation, ...code };
}
