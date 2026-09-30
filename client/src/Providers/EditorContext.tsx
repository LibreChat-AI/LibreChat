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
 * remount is a host change, not a new decision by the user. It is recorded per
 * artifact for the same reason as the code buffer: a rejection for one
 * artifact must neither suppress a save for another nor be overwritten by
 * another's refusal.
 *
 * A buffer another artifact displaces is retained under the artifact it
 * belongs to: the edit's debounce died with the selection change, so the
 * retained copy is the only place that text still lives, and the editor that
 * gets the artifact back restores and sends it from there.
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
 *
 * `savedContent` is what this tab knows the server holds for each artifact,
 * read and written synchronously because save callbacks run between renders.
 * It outlives a session: the server's content does not change when the pane
 * closes.
 */
interface CodeContextType {
  currentCode?: string;
  codeArtifactId?: string;
  retainedCode: Record<string, string>;
  setCurrentCode: (code: string | undefined, artifactId?: string) => void;
  rejectedCode: Record<string, string>;
  setRejectedCode: (code: string | undefined, artifactId?: string) => void;
  clearCode: (artifactId: string) => void;
  codeSession: { current: number };
  endCodeSession: () => void;
  savedContent: SavedContentLedger;
}

/**
 * A successful save is the server's content before the registry shows it: the
 * edited message propagates afterwards. `base` is the text the last save wrote,
 * and `pending` the values the registry may still show until it catches up, in
 * the order they were replaced. Anything else the registry shows is a change
 * made elsewhere, which wins. `savedBuffer` is the buffer text that save wrote
 * until the buffer changes again: only that copy is known to be saved.
 */
type SavedContent = { base: string; pending: string[]; savedBuffer: string | null };
export type SavedContentLedger = { current: Record<string, SavedContent> };

export function recordSave(
  ledger: SavedContentLedger,
  artifactId: string,
  original: string,
  updated: string,
): void {
  const previous = ledger.current[artifactId];
  ledger.current[artifactId] = {
    base: updated,
    pending: [...(previous?.pending ?? []), original],
    savedBuffer: updated,
  };
}

/**
 * The content an edit of this artifact replaces. Only the values the registry
 * showed before this tab's own saves count as lag; once it reaches the saved
 * text, or moves anywhere else, it is the truth again, so a later revert to an
 * earlier value is not mistaken for lag.
 */
export function resolveServerContent(
  ledger: SavedContentLedger,
  artifactId: string,
  registry: string | undefined,
): string | undefined {
  const entry = ledger.current[artifactId];
  if (entry == null || registry == null) {
    return registry ?? entry?.base;
  }
  const lagging = registry === entry.base ? -1 : entry.pending.indexOf(registry);
  if (lagging >= 0) {
    /* The registry has passed every value before this one. */
    if (lagging > 0) {
      ledger.current[artifactId] = { ...entry, pending: entry.pending.slice(lagging) };
    }
    return entry.base;
  }
  if (entry.pending.length > 0) {
    ledger.current[artifactId] = { ...entry, pending: [] };
  }
  return registry;
}

/** Whether this buffer text is the copy the last save wrote, so it is not unsaved. */
export function isSavedText(ledger: SavedContentLedger, artifactId: string, text: string): boolean {
  return ledger.current[artifactId]?.savedBuffer === text;
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
  const [codeState, setCodeState] = useState<{
    buffer: { code?: string; artifactId?: string };
    retained: Record<string, string>;
  }>({ buffer: {}, retained: {} });
  const [rejectedCode, setRejectedState] = useState<Record<string, string>>({});
  const codeSession = useRef(0);
  const savedContent = useRef<Record<string, SavedContent>>({});

  const setCurrentCode = useCallback((code: string | undefined, artifactId?: string) => {
    setCodeState((previous) => {
      if (code === undefined) {
        return { ...previous, buffer: {} };
      }
      /* The buffer keeps its owner when the writer does not name one. */
      const owner = artifactId ?? previous.buffer.artifactId;
      const { code: wasCode, artifactId: wasOwner } = previous.buffer;
      const retained = { ...previous.retained };
      /* Displacing another artifact's buffer retains that text under its
       * owner; writing for the same artifact makes the active slot the newest
       * text again, so its retained copy retires. */
      if (wasCode != null && wasOwner != null && wasOwner !== owner) {
        retained[wasOwner] = wasCode;
      }
      if (owner != null) {
        const before = wasOwner === owner ? wasCode : previous.retained[owner];
        const entry = savedContent.current[owner];
        /* Any change to the text makes it the user's again, even one that
         * lands back on what was saved. */
        if (entry != null && before !== code) {
          savedContent.current[owner] = { ...entry, savedBuffer: null };
        }
        delete retained[owner];
      }
      return { buffer: { code, artifactId: owner }, retained };
    });
  }, []);

  const setRejectedCode = useCallback((code: string | undefined, artifactId?: string) => {
    setRejectedState((previous) => {
      if (artifactId == null) {
        return code === undefined ? {} : previous;
      }
      const next = { ...previous };
      if (code === undefined) {
        delete next[artifactId];
      } else {
        next[artifactId] = code;
      }
      return next;
    });
  }, []);

  const clearCode = useCallback((artifactId: string) => {
    setCodeState((previous) => {
      const retained = { ...previous.retained };
      delete retained[artifactId];
      const buffer = previous.buffer.artifactId === artifactId ? {} : previous.buffer;
      return { buffer, retained };
    });
  }, []);

  const endCodeSession = useCallback(() => {
    codeSession.current += 1;
    setCodeState({ buffer: {}, retained: {} });
    setRejectedState({});
  }, []);

  const mutationValue = useMemo(() => ({ isMutating }), [isMutating]);
  const codeValue = useMemo(
    () => ({
      currentCode: codeState.buffer.code,
      codeArtifactId: codeState.buffer.artifactId,
      retainedCode: codeState.retained,
      setCurrentCode,
      rejectedCode,
      setRejectedCode,
      clearCode,
      codeSession,
      endCodeSession,
      savedContent,
    }),
    [clearCode, codeState, endCodeSession, rejectedCode, setCurrentCode, setRejectedCode],
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

/**
 * The text an artifact's editing surface should show: its active buffer when
 * the artifact owns it, the copy retained when another artifact's edit
 * displaced it, and nothing when the artifact never had unsaved text. Every
 * consumer of the buffer (the editor, both tab hosts, download) resolves it
 * the same way, so the code tab, the preview and an export can never disagree
 * about which text is the artifact's own.
 */
export function useArtifactCode(artifactId: string): string | undefined {
  const { currentCode, codeArtifactId, retainedCode } = useCodeState();
  return codeArtifactId === artifactId ? currentCode : retainedCode[artifactId];
}
