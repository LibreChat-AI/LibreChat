import type { TFileConfig } from 'librechat-data-provider';

interface StoredBlobFile {
  filepath: string;
  user?: { toString(): string };
}

interface OwnedBlobDeleteDependencies {
  extractPath: (url: string) => string;
  deleteBlob: (path: string) => Promise<unknown>;
  isMissing: (error: unknown) => boolean;
  deleteRagFile: (args: {
    userId: string;
    file: StoredBlobFile;
    fileConfig?: TFileConfig;
  }) => Promise<unknown>;
}

/** File descriptors cannot override the storage owner supplied by the request. */
export function createOwnedBlobFileDeleter({
  extractPath,
  deleteBlob,
  isMissing,
  deleteRagFile,
}: OwnedBlobDeleteDependencies) {
  return async (
    req: { user: { id: string }; config?: { fileConfig?: TFileConfig } },
    file: StoredBlobFile,
  ): Promise<void> => {
    const ownerId = req.user.id;
    const blobPath = extractPath(file.filepath);
    const segments = blobPath.split('/');
    // saveBuffer stores at <basePath>/<ownerId>/<filename>; the exact owner segment
    // must be adjacent to the file name, not merely a substring elsewhere in the URL.
    if (
      !ownerId ||
      segments.length < 3 ||
      segments[segments.length - 2] !== ownerId ||
      !segments[segments.length - 1]
    ) {
      throw new Error('Invalid file path');
    }

    if (
      (await deleteRagFile({
        userId: ownerId,
        file,
        ...(req.config?.fileConfig ? { fileConfig: req.config.fileConfig } : {}),
      })) === false
    ) {
      throw new Error('Vector deletion was not confirmed');
    }
    try {
      await deleteBlob(blobPath);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  };
}

export function extractAzureBlobPath(filepath: string, containerName: string): string {
  const segments = new URL(filepath).pathname.split('/').filter(Boolean);
  const containerIndex = segments.indexOf(containerName);
  if (containerIndex < 0 || containerIndex === segments.length - 1) {
    throw new Error('Invalid Azure blob path');
  }
  return segments
    .slice(containerIndex + 1)
    .map(decodeURIComponent)
    .join('/');
}

export function extractFirebaseBlobPath(filepath: string): string {
  const pathname = new URL(filepath).pathname;
  const objectIndex = pathname.indexOf('/o/');
  if (objectIndex < 0) throw new Error('Invalid Firebase blob path');
  return decodeURIComponent(pathname.slice(objectIndex + 3));
}
