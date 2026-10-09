import { ContentTypes } from 'librechat-data-provider';

/**
 * Which links a migration writes: LibreChat's own (`stored`), or the storage
 * service's presigned or blob URLs (`storage`), for turning the proxy back off.
 */
export type RelinkDirection = 'stored' | 'storage';

export interface RelinkFileRef {
  source?: string;
  filepath?: string;
  storageKey?: string;
}

/** Converts one storage source's links between its own form and LibreChat's. */
export interface Relinker {
  source: string;
  /**
   * LibreChat's link for a storage link of this source, or `null` when `link` is not one.
   * With no `source` on the record (a user's avatar), the link alone must identify it.
   */
  toStored: (link: string, storageKey?: string) => string | null;
  /** The storage service's link for one of LibreChat's links to this source, or `null`. */
  toStorage: (link: string) => Promise<string | null>;
}

/** Rewrites one link, or returns `null` when it is already in the target form or not a stored file. */
export async function relinkLink(
  link: string | undefined,
  direction: RelinkDirection,
  relinkers: Relinker[],
  source?: string,
  storageKey?: string,
): Promise<string | null> {
  if (!link) {
    return null;
  }
  for (const relinker of relinkers) {
    if (source != null && source !== relinker.source) {
      continue;
    }
    const next: string | null =
      direction === 'stored' ? relinker.toStored(link, storageKey) : await relinker.toStorage(link);
    if (next != null && next !== link) {
      return next;
    }
  }
  return null;
}

/** Rewrites a file record's `filepath` in place; returns whether it changed. */
export async function relinkFileRef(
  file: RelinkFileRef | null | undefined,
  direction: RelinkDirection,
  relinkers: Relinker[],
): Promise<boolean> {
  if (!file?.source || !file.filepath) {
    return false;
  }
  const next = await relinkLink(file.filepath, direction, relinkers, file.source, file.storageKey);
  if (next == null) {
    return false;
  }
  file.filepath = next;
  return true;
}

async function relinkAll(
  files: unknown,
  direction: RelinkDirection,
  relinkers: Relinker[],
): Promise<boolean> {
  if (!Array.isArray(files)) {
    return false;
  }
  let changed = false;
  for (const file of files as Array<RelinkFileRef | null>) {
    changed = (await relinkFileRef(file, direction, relinkers)) || changed;
  }
  return changed;
}

interface ContentPart {
  type?: string;
  files?: RelinkFileRef[] | null;
  image_file?: RelinkFileRef | null;
}

/**
 * Rewrites the file links a message carries, in place: its `files` and
 * `attachments`, and those in content parts (a steer part's `files`, an
 * `image_file` part's image). Returns the fields that changed, for a `$set`.
 */
export async function relinkMessage(
  message: { files?: unknown; attachments?: unknown; content?: unknown },
  direction: RelinkDirection,
  relinkers: Relinker[],
): Promise<Partial<Record<'files' | 'attachments' | 'content', unknown>>> {
  const changes: Partial<Record<'files' | 'attachments' | 'content', unknown>> = {};
  if (await relinkAll(message.files, direction, relinkers)) {
    changes.files = message.files;
  }
  if (await relinkAll(message.attachments, direction, relinkers)) {
    changes.attachments = message.attachments;
  }
  if (Array.isArray(message.content)) {
    let contentChanged = false;
    for (const part of message.content as Array<ContentPart | null>) {
      contentChanged = (await relinkAll(part?.files, direction, relinkers)) || contentChanged;
      if (part?.type === ContentTypes.IMAGE_FILE) {
        contentChanged =
          (await relinkFileRef(part.image_file, direction, relinkers)) || contentChanged;
      }
    }
    if (contentChanged) {
      changes.content = message.content;
    }
  }
  return changes;
}
