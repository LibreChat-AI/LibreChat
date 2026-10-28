import path from 'path';
import crypto from 'node:crypto';
import { EModelEndpoint } from 'librechat-data-provider';
import { mkdir, copyFile, rename, unlink, writeFile } from 'fs/promises';
import type { TFileConfig } from 'librechat-data-provider';
import { stripCacheBust } from './path';

export interface LocalStoragePaths {
  publicPath: string;
  uploads: string;
}

interface LocalFile {
  file_id: string;
  filepath: string;
  user?: { toString(): string };
}

interface LocalDeleteRequest {
  user: { id: string };
  config: { paths: LocalStoragePaths; fileConfig?: TFileConfig };
}

interface LocalFileDeleteDependencies {
  deleteRagFile: (args: {
    userId: string;
    file: LocalFile;
    fileConfig?: TFileConfig;
  }) => Promise<unknown>;
  logger: { warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
}

/** Deletes only within the request owner's namespace, and reports storage failures to callers. */
export function createLocalFileDeleter({ deleteRagFile, logger }: LocalFileDeleteDependencies) {
  const unlinkStoredFile = async (filepath: string) => {
    try {
      await unlink(filepath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        logger.warn('Local file was already missing during delete:', error);
        return;
      }
      logger.error('Error deleting file:', error);
      throw error;
    }
  };

  return async (req: LocalDeleteRequest, file: LocalFile): Promise<void> => {
    const { publicPath, uploads } = req.config.paths;
    const ownerId = req.user.id;
    const ragParams = {
      userId: ownerId,
      file,
      ...(req.config.fileConfig ? { fileConfig: req.config.fileConfig } : {}),
    };
    if (!ownerId) throw new Error('Invalid file owner');
    const cleanFilepath = stripCacheBust(file.filepath);
    const uploadPrefix = `/uploads/${ownerId}/`;

    if (cleanFilepath.startsWith(uploadPrefix)) {
      const userUploadDir = path.join(uploads, ownerId);
      const filePath = path.join(userUploadDir, cleanFilepath.slice(uploadPrefix.length));
      if (!isStrictlyWithin(userUploadDir, filePath)) {
        throw new Error(`Invalid file path: ${cleanFilepath}`);
      }
      if ((await deleteRagFile(ragParams)) === false) {
        throw new Error('Vector deletion was not confirmed');
      }
      await unlinkStoredFile(filePath);
      return;
    }

    const parts = cleanFilepath.split(path.sep);
    const subfolder = parts[1];
    if (!subfolder && parts[0] === EModelEndpoint.agents) {
      if ((await deleteRagFile(ragParams)) === false) {
        throw new Error('Vector deletion was not confirmed');
      }
      logger.warn(`Agent File ${file.file_id} is missing filepath, may have been deleted already`);
      return;
    }
    const filePath = path.join(publicPath, cleanFilepath);
    if (!subfolder || !isStrictlyWithin(path.join(publicPath, subfolder, ownerId), filePath)) {
      throw new Error('Invalid file path');
    }
    if ((await deleteRagFile(ragParams)) === false) {
      throw new Error('Vector deletion was not confirmed');
    }
    await unlinkStoredFile(filePath);
  };
}

function isStrictlyWithin(directory: string, filePath: string): boolean {
  const rel = path.relative(path.resolve(directory), path.resolve(filePath));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel) && !rel.includes(`..${path.sep}`);
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
