import { randomUUID } from 'node:crypto';
import { logger } from '@librechat/data-schemas';
import type { UpsertSkillFileInput } from '@librechat/data-schemas';
import type { TSkillFile } from 'librechat-data-provider';
import type { ServerRequest, StrategyFunctions } from '~/types';
import type { SaveBufferParams } from '~/storage/types';
import type { StoredSkillFile } from './upload';
import { resolveRequestTenantId } from '~/middleware/tenant';
import { getStorageMetadata } from '~/storage/metadata';

interface SkillFileSaveDeps {
  getSkillFileByPath: (skillId: string, relativePath: string) => Promise<StoredSkillFile | null>;
  upsertSkillFile: (
    row: Omit<UpsertSkillFileInput, 'skillId' | 'author'> & { skillId: string; author: string },
  ) => Promise<(StoredSkillFile & { bytes: number; relativePath: string }) | null>;
  resolveStorage: (
    req: ServerRequest,
    options: { isImage: boolean },
  ) => { source: TSkillFile['source']; saveBuffer: (params: SaveBufferParams) => Promise<string> };
  getStrategyFunctions: (source: string) => Partial<StrategyFunctions>;
}

interface SaveSkillFileParams {
  req: ServerRequest;
  skillId: { toString(): string };
  relativePath: string;
  content: string;
  mimeType: string;
  expectedFileId?: string;
  createOnly: boolean;
}

type ManagementFileSaveParams = Omit<SaveSkillFileParams, 'expectedFileId' | 'createOnly'>;
type SavedSkillFile = { bytes: number; relativePath: string };

/** Agent edits must carry the file revision captured alongside their original content. */
export function createSkillFileSaver(
  deps: SkillFileSaveDeps,
): (params: SaveSkillFileParams) => Promise<SavedSkillFile> {
  return (params) => saveSkillFile(deps, params, 'captured');
}

/** Management PUT sends complete content, so it matches the revision current at request time. */
export function createSkillManagementFileSaver(
  deps: SkillFileSaveDeps,
): (params: ManagementFileSaveParams) => Promise<SavedSkillFile> {
  return (params) => saveSkillFile(deps, { ...params, createOnly: false }, 'current');
}

async function saveSkillFile(
  deps: SkillFileSaveDeps,
  {
    req,
    skillId: skillIdValue,
    relativePath,
    content,
    mimeType,
    expectedFileId,
    createOnly,
  }: SaveSkillFileParams,
  revisionMode: 'captured' | 'current',
): Promise<SavedSkillFile> {
  const user = req.user;
  if (!user?.id) {
    throw new Error('Authentication required to save a skill file');
  }
  const userId = user.id;
  const skillId = skillIdValue.toString();
  const existingFile = await deps.getSkillFileByPath(skillId, relativePath);
  const insertOnly = revisionMode === 'current' ? existingFile == null : createOnly;
  const revision = revisionMode === 'current' ? existingFile?.file_id : expectedFileId;
  if (
    (insertOnly && (existingFile != null || revision !== undefined)) ||
    (!insertOnly && (!revision || existingFile?.file_id !== revision))
  ) {
    throw Object.assign(new Error('Skill file changed since it was read'), {
      code: 'SKILL_FILE_CONFLICT',
    });
  }

  const tenantId = resolveRequestTenantId(req);
  const fileId = randomUUID();
  const filename = relativePath.slice(relativePath.lastIndexOf('/') + 1);
  const buffer = Buffer.from(content, 'utf8');
  const storage = deps.resolveStorage(req, { isImage: mimeType.startsWith('image/') });
  const filepath = await storage.saveBuffer({
    userId,
    buffer,
    fileName: `${fileId}__${filename}`,
    basePath: 'uploads',
    tenantId,
  });
  const storageMetadata = getStorageMetadata({ filepath, source: storage.source });
  const cleanupPreviousBlob = (): void => {
    if (!existingFile || existingFile.filepath === filepath) {
      return;
    }
    const deleteFile = deps.getStrategyFunctions(existingFile.source).deleteFile;
    if (deleteFile) {
      deleteFile(req, {
        filepath: existingFile.filepath,
        storageKey: existingFile.storageKey,
        storageRegion: existingFile.storageRegion,
        user: existingFile.author?.toString() ?? userId,
        tenantId: existingFile.tenantId ?? tenantId,
      }).catch((error: Error) =>
        logger.error('[saveSkillFileContent] Old blob cleanup failed:', error),
      );
    }
  };

  let result: StoredSkillFile & { bytes: number; relativePath: string };
  try {
    const saved = await deps.upsertSkillFile({
      skillId,
      relativePath,
      expectedFileId: revision,
      createOnly: insertOnly,
      file_id: fileId,
      filename,
      filepath,
      ...storageMetadata,
      source: storage.source,
      mimeType,
      bytes: buffer.length,
      isExecutable: existingFile?.isExecutable ?? false,
      author: user._id?.toString() ?? userId,
      tenantId,
    });
    if (!saved) {
      throw Object.assign(new Error('Skill file save failed to persist metadata'), {
        code: 'SKILL_FILE_UPSERT_NOT_FOUND',
      });
    }
    result = saved;
  } catch (error) {
    try {
      const persisted = await deps.getSkillFileByPath(skillId, relativePath);
      if (persisted?.file_id === fileId) {
        cleanupPreviousBlob();
      } else {
        await deps.getStrategyFunctions(storage.source).deleteFile?.(req, {
          filepath,
          ...storageMetadata,
          user: userId,
          tenantId,
        });
      }
    } catch (cleanupError) {
      logger.error('[saveSkillFileContent] Failed to clean up uploaded blob:', cleanupError);
    }
    throw error;
  }

  cleanupPreviousBlob();
  return { bytes: result.bytes, relativePath: result.relativePath };
}
