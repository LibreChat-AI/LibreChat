import path from 'path';
import crypto from 'node:crypto';
import { mkdir, copyFile, rename, unlink, writeFile } from 'fs/promises';

export interface LocalStoragePaths {
  publicPath: string;
  uploads: string;
}

/**
 * Fills a sibling temp file and renames it into place, so concurrent writers to one path each
 * land whole (last rename wins) and readers never see a partly written file. The temp name is
 * fixed length rather than derived from the target, so a target name near NAME_MAX still fits.
 */
async function replaceAtomically(
  filePath: string,
  fill: (tempPath: string) => Promise<void>,
): Promise<void> {
  const tempPath = path.join(path.dirname(filePath), `.${crypto.randomUUID()}.tmp`);
  try {
    await fill(tempPath);
    await rename(tempPath, filePath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

export async function writeFileAtomic(filePath: string, data: Buffer | string): Promise<void> {
  await replaceAtomically(filePath, (tempPath) => writeFile(tempPath, data));
}

/** Resolves `fileName` inside `directory`, rejecting a name that would escape it. */
function resolveContained(directory: string, fileName: string): string {
  const resolvedDir = path.resolve(directory);
  const resolvedPath = path.resolve(resolvedDir, fileName);
  const rel = path.relative(resolvedDir, resolvedPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(`..${path.sep}`)) {
    throw new Error('Path traversal detected in filename');
  }
  return resolvedPath;
}

/** Creates `directory` if needed and writes `data` to `fileName` inside it atomically. */
export async function writeLocalFile(
  directory: string,
  fileName: string,
  data: Buffer | string,
): Promise<string> {
  const filePath = resolveContained(directory, fileName);
  await mkdir(directory, { recursive: true });
  await writeFileAtomic(filePath, data);
  return path.join(directory, fileName);
}

/** Moves a temp upload into `directory` as `fileName`, creating the directory if needed. */
export async function moveLocalFile(
  sourcePath: string,
  directory: string,
  fileName: string,
): Promise<string> {
  const filePath = resolveContained(directory, fileName);
  await mkdir(directory, { recursive: true });
  await replaceAtomically(filePath, (tempPath) => copyFile(sourcePath, tempPath));
  await unlink(sourcePath);
  return path.join(directory, fileName);
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
  basePath?: 'images' | 'uploads';
}): Promise<string> {
  const directory =
    basePath === 'images'
      ? path.join(paths.publicPath, basePath, userId)
      : path.join(paths.uploads, userId);
  await writeLocalFile(directory, fileName, buffer);
  return path.posix.join('/', basePath, userId, fileName);
}
