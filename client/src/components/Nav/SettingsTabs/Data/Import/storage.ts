import { LocalStorageKeys } from 'librechat-data-provider';

/**
 * The id of the import the panel should rejoin. The key is scoped by user so
 * another account in the same browser cannot consume or clear it. A confirmed
 * import runs in the background for minutes; without this the panel forgets it
 * the moment it unmounts, and there is no endpoint to list a user's jobs to
 * recover from. Reads and writes are guarded because `localStorage` throws in
 * private-browsing and storage-disabled contexts.
 */
function activeJobKey(userId: string): string {
  return `${LocalStorageKeys.IMPORT_JOB_ID}:${userId}`;
}

export function readActiveJobId(userId: string | undefined): string | null {
  if (!userId) {
    return null;
  }
  try {
    return window.localStorage.getItem(activeJobKey(userId));
  } catch {
    return null;
  }
}

export function writeActiveJobId(userId: string | undefined, jobId: string | null): void {
  if (!userId) {
    return;
  }
  try {
    if (jobId == null) {
      window.localStorage.removeItem(activeJobKey(userId));
      return;
    }
    window.localStorage.setItem(activeJobKey(userId), jobId);
  } catch {
    return;
  }
}
