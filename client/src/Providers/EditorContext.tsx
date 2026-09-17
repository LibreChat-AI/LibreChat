import React, { createContext, useContext, useState, useMemo, useCallback, useRef } from 'react';
import { useIsMutating } from '@tanstack/react-query';
import { MutationKeys } from 'librechat-data-provider';

/**
 * Mutation state context - for components that need to know about save/edit status
 * Separated from code state to prevent unnecessary re-renders
 *
 * The state is the request's, not a flag anyone sets: a save outlives the
 * editor that started it — React Query keeps it — and an editor that appears
 * while one is running has to see it. Reading the mutation cache makes "a save
 * is in flight" true exactly while one is, so no session can release a lock it
 * does not hold and none can be left behind by a pane the user closed.
 */
interface MutationContextType {
  isMutating: boolean;
}

/**
 * Code state context - for components that need the current code content
 * Changes frequently (on every keystroke), so only subscribe if needed.
 *
 * The buffer carries the artifact it belongs to. The pane is remounted when it
 * changes hosts (side panel, mobile sheet, undocked window), so whether the
 * buffer is this artifact's unsaved text cannot be decided from a mount.
 *
 * `rejectedCode` is session state rather than editor-instance state because a
 * remount is a host change, not a new decision by the user. It carries the
 * artifact identity for the same reason as the code buffer: a rejection for
 * one artifact must not suppress a save for another.
 *
 * `codeSession` is the editing session the buffer belongs to. A save keeps its
 * callbacks after the editor that started it is gone, and those callbacks
 * would otherwise write the buffer a closed session just cleared and submit
 * its queued edit — so they compare the session they were started in against
 * this live counter. It is a mutable object rather than a value because the
 * comparison happens after the reader's last render.
 *
 * Ending a session leaves a running save alone: the request is not the
 * session's to cancel, and nothing waits on a flag it could clear.
 */
interface CodeContextType {
  currentCode?: string;
  codeArtifactId?: string;
  setCurrentCode: (code: string | undefined, artifactId?: string) => void;
  rejectedCode?: string;
  rejectedCodeArtifactId?: string;
  setRejectedCode: (code: string | undefined, artifactId?: string) => void;
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
  const isMutating = useIsMutating({ mutationKey: [MutationKeys.editArtifact] }) > 0;
  const [codeBuffer, setCodeBuffer] = useState<{ code?: string; artifactId?: string }>({});
  const [rejectedBuffer, setRejectedBuffer] = useState<{
    code?: string;
    artifactId?: string;
  }>({});
  const codeSession = useRef(0);

  const setCurrentCode = useCallback((code: string | undefined, artifactId?: string) => {
    setCodeBuffer((previous) => ({
      code,
      artifactId: artifactId ?? (code === undefined ? undefined : previous.artifactId),
    }));
  }, []);

  const setRejectedCode = useCallback((code: string | undefined, artifactId?: string) => {
    setRejectedBuffer(code === undefined ? {} : { code, artifactId });
  }, []);

  const endCodeSession = useCallback(() => {
    codeSession.current += 1;
    setCodeBuffer({});
    setRejectedBuffer({});
  }, []);

  const mutationValue = useMemo(() => ({ isMutating }), [isMutating]);
  const codeValue = useMemo(
    () => ({
      currentCode: codeBuffer.code,
      codeArtifactId: codeBuffer.artifactId,
      setCurrentCode,
      rejectedCode: rejectedBuffer.code,
      rejectedCodeArtifactId: rejectedBuffer.artifactId,
      setRejectedCode,
      codeSession,
      endCodeSession,
    }),
    [codeBuffer, endCodeSession, rejectedBuffer, setCurrentCode, setRejectedCode],
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
