import { randomUUID } from 'node:crypto';
import type { UpsertSkillFileInput } from '@librechat/data-schemas';
import type { TSkillFile } from 'librechat-data-provider';
import type { ServerRequest, StrategyFunctions } from '~/types';
import type { SaveBufferParams } from '~/storage/types';
import type { SkillUploadIntentDeps } from './intent';
import type { StoredSkillFile } from './upload';
import { resolveRequestTenantId } from '~/middleware/tenant';
import { getStorageMetadata } from '~/storage/metadata';
import { withSkillUploadIntent } from './intent';
import { reserveSkillBlob } from './reservation';

interface SkillFileSaveDeps extends SkillUploadIntentDeps {
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
  const strategy = deps.getStrategyFunctions(storage.source) as Partial<StrategyFunctions> & {
    getFileURL?: (params: {
      userId: string;
      fileName: string;
      basePath: string;
      tenantId?: string;
    }) => Promise<string>;
  };
  if (!strategy.deleteFile) throw new Error('Skill storage has no deletion strategy');
  const fileName = `${fileId}__${filename}`;
  const reservation = await reserveSkillBlob({
    source: storage.source,
    userId,
    fileName,
    tenantId,
    getFileURL: strategy.getFileURL,
  });
  const result = await withSkillUploadIntent(deps, {
    skillId,
    author: user._id?.toString() ?? userId,
    tenantId,
    fileId,
    source: storage.source,
    reservation,
    save: () => storage.saveBuffer({ ...reservation.writeLocation, buffer }),
    persist: async (filepath) => {
      const row = await deps.upsertSkillFile({
        skillId,
        relativePath,
        expectedFileId: revision,
        createOnly: insertOnly,
        file_id: fileId,
        filename,
        filepath,
        ...getStorageMetadata({ filepath, source: storage.source }),
        source: storage.source,
        mimeType,
        bytes: buffer.length,
        isExecutable: existingFile?.isExecutable ?? false,
        author: user._id?.toString() ?? userId,
        tenantId,
      });
      if (!row) {
        throw Object.assign(new Error('Skill file upsert returned no row'), {
          code: 'SKILL_FILE_UPSERT_NOT_FOUND',
        });
      }
      return { filepath: row.filepath, bytes: buffer.length, relativePath };
    },
    readPersisted: async () => {
      const persisted = await deps.getSkillFileByPath(skillId, relativePath);
      return persisted?.file_id === fileId
        ? { filepath: persisted.filepath, bytes: buffer.length, relativePath }
        : null;
    },
    deleteReserved: (file, savedPath) =>
      strategy.deleteFile!(req, {
        filepath: savedPath ?? file.filepath,
        ...getStorageMetadata({ filepath: savedPath ?? file.filepath, source: storage.source }),
        user: userId,
        tenantId,
      }),
  });
  return { bytes: result.bytes, relativePath: result.relativePath };
}
