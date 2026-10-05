import { openAsBlob } from 'fs';

/**
 * A staged upload as a provider SDK accepts it, under the name the user gave it.
 *
 * Staging prefixes a per-request id to the path, and the name is what a provider's file
 * list and citations show. The Blob is backed by the file on disk, so the upload streams
 * from it; wrapping a read stream with an SDK's `toFile` would buffer the whole file.
 */
export async function openNamedUpload(filePath: string, name: string): Promise<File> {
  return new File([await openAsBlob(filePath)], name);
}
