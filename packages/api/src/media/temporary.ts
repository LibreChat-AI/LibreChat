import path from 'node:path';

/** Owner IDs form one segment in the shared upload temp tree. */
export function mediaTemporaryDirectory(tempDirectory: string, ownerId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(ownerId))
    throw new Error('Media staging requires a valid owner ID.');
  return path.join(path.resolve(tempDirectory), ownerId, 'media');
}
