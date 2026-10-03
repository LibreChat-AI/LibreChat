import path from 'path';
import crypto from 'node:crypto';
import { mkdir, copyFile, rename, unlink, writeFile } from 'fs/promises';

export interface LocalStoragePaths {
  publicPath: string;
  uploads: string;
}

/**
 * Writes through a sibling temp file and a rename, so concurrent writers to one path each
 * land whole (last rename wins) instead of interleaving bytes in a shared truncated file.
 */
export async function writeFileAtomic(filePath: string, data: Buffer | string): Promise<void> {
  const tempPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, data);
    await rename(tempPath, filePath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

/** Creates `directory` if needed and writes `data` to `fileName` inside it atomically. */
export async function writeLocalFile(
  directory: string,
  fileName: string,
  data: Buffer | string,
): Promise<string> {
  await mkdir(directory, { recursive: true });
  const filePath = path.join(directory, fileName);
  await writeFileAtomic(filePath, data);
  return filePath;
}

/** Moves a temp upload into `directory` as `fileName`, creating the directory if needed. */
export async function moveLocalFile(
  sourcePath: string,
  directory: string,
  fileName: string,
): Promise<string> {
  await mkdir(directory, { recursive: true });
  const filePath = path.join(directory, fileName);
  await copyFile(sourcePath, filePath);
  await unlink(sourcePath);
  return filePath;
}

/**
 * Saves a buffer under `publicPath/images/userId` (served statically) or `uploads/userId`
 * (downloaded through the API) and returns its URL path. Rejects a `fileName` that
 * resolves outside that directory before touching the file system.
 */
export async function saveLocalBuffer({
  paths,
  userId,
  buffer,
  fileName,
  basePath = 'images',
}: {
  paths: LocalStoragePaths;
  userId: string;
  buffer: Buffer;
  fileName: string;
  basePath?: string;
}): Promise<string> {
  const directory =
    basePath === 'images'
      ? path.join(paths.publicPath, basePath, userId)
      : path.join(paths.uploads, userId);

  const resolvedDir = path.resolve(directory);
  const resolvedPath = path.resolve(resolvedDir, fileName);
  const rel = path.relative(resolvedDir, resolvedPath);
  if (rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(`..${path.sep}`)) {
    throw new Error('Path traversal detected in filename');
  }

  await writeLocalFile(resolvedDir, rel, buffer);
  return path.posix.join('/', basePath, userId, fileName);
}
