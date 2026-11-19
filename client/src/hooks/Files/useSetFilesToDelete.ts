import { useCallback } from 'react';
import { LocalStorageKeys } from 'librechat-data-provider';

export default function useSetFilesToDelete() {
  const setFilesToDelete = useCallback(
    (files: Record<string, unknown>) =>
      localStorage.setItem(LocalStorageKeys.FILES_TO_DELETE, JSON.stringify(files)),
    [],
  );
  return setFilesToDelete;
}

/** Snapshot app-owned file markers without consuming another pane or newer upload edits. */
export function captureFilesToDelete(keys: readonly string[]): () => void {
  const read = (): Record<string, unknown> | undefined => {
    try {
      const raw = localStorage.getItem(LocalStorageKeys.FILES_TO_DELETE);
      if (raw == null) return;
      const files: Record<string, unknown> | null = JSON.parse(raw);
      return files != null && typeof files === 'object' && !Array.isArray(files)
        ? files
        : undefined;
    } catch {
      return;
    }
  };
  const owned = new Set(keys);
  const captured = Object.entries(read() ?? {})
    .filter(([key]) => owned.has(key))
    .map(([key, file]) => [key, JSON.stringify(file)] as const);
  return () => {
    if (captured.length === 0) return;
    const current = read();
    if (current == null) return;
    let changed = false;
    for (const [key, value] of captured) {
      if (
        !Object.prototype.hasOwnProperty.call(current, key) ||
        JSON.stringify(current[key]) !== value
      )
        continue;
      delete current[key];
      changed = true;
    }
    if (changed) {
      try {
        localStorage.setItem(LocalStorageKeys.FILES_TO_DELETE, JSON.stringify(current));
      } catch {
        /* Storage cannot interrupt an accepted turn's ownership commit. */
      }
    }
  };
}
