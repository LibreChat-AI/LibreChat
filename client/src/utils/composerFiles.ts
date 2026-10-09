/**
 * Composer attachments a during-run submit has already consumed.
 *
 * Taking files into a steer or a queued message clears them from the composer,
 * but an upload for one of them can still have async callbacks in flight
 * (`loadImage`'s `onload`, HEIC conversion progress, the resize pass). Those
 * callbacks write the file back with a `set`, which resurrects an attachment
 * the message already owns: it reappears in the composer and rides the user's
 * NEXT message too.
 *
 * Held outside React state because the decision is synchronous and crosses two
 * hooks that never share an instance: `useSteering` consumes, `useUpdateFiles`
 * writes. Ids are per-upload UUIDs (or a library file's own id), so an upload
 * the user starts AFTER the submit is never confused with a consumed one.
 */

/** Bounded so a long session cannot grow the set without limit; far beyond the
 *  handful of callbacks that can still be in flight for one submit. */
const TAKEN_LIMIT = 200;

const takenFileIds = new Set<string>();

export function markComposerFilesTaken(fileIds: readonly string[]): void {
  for (const id of fileIds) {
    if (id.length === 0) {
      continue;
    }
    takenFileIds.delete(id);
    takenFileIds.add(id);
  }
  while (takenFileIds.size > TAKEN_LIMIT) {
    const oldest = takenFileIds.values().next();
    if (oldest.done === true) {
      return;
    }
    takenFileIds.delete(oldest.value);
  }
}

/** Whether a write for this id is a late callback for an already-consumed
 *  attachment, rather than part of an attachment the composer still holds. */
export function isComposerFileTaken(id: string): boolean {
  return takenFileIds.has(id);
}

/**
 * Forgets a consumed id, so the SAME file can be attached again on purpose.
 * Re-attaching a library file reuses its server id, and a permanent mark would
 * make that attachment silently impossible for the rest of the session.
 */
export function releaseComposerFile(id: string): void {
  takenFileIds.delete(id);
}
