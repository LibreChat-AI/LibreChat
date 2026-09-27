import { randomUUID } from 'crypto';
import { logger, validateRelativePath } from '@librechat/data-schemas';
import type { UpsertSkillFileInput } from '@librechat/data-schemas';
import type { TSkillFile, TSkill } from 'librechat-data-provider';
import type { Response } from 'express';
import type { StrategyFunctions, ServerRequest } from '~/types';
import type { SaveBufferParams } from '~/storage/types';
import { resolveRequestTenantId } from '~/middleware/tenant';
import { getStorageMetadata } from '~/storage/metadata';
import { blockFilteredSkillFile } from './protection';
import { resolveSkillFilePathParam } from './path';

/** Metadata required for replacement and cleanup, independent of a database document. */
export interface StoredSkillFile {
  file_id: string;
  filepath: string;
  source: string;
  storageKey?: string;
  storageRegion?: string;
  tenantId?: string;
  author?: { toString(): string };
  isExecutable?: boolean;
}

interface SkillUploadDeps {
  getSkillFileByPath: (skillId: string, relativePath: string) => Promise<StoredSkillFile | null>;
  getSkillById: (id: string) => Promise<Pick<TSkill, 'source'> | null>;
  upsertSkillFile: (
    row: Omit<UpsertSkillFileInput, 'skillId' | 'author'> & { skillId: string; author: string },
  ) => Promise<StoredSkillFile>;
  resolveStorage: (
    req: ServerRequest,
    options: { isImage: boolean },
  ) => { source: TSkillFile['source']; saveBuffer: (params: SaveBufferParams) => Promise<string> };
  getStrategyFunctions: (source: string) => Partial<StrategyFunctions>;
}

type UploadRequest = ServerRequest & {
  body: { relativePath?: string; expectedFileId?: string };
  resourceAccess?: { resourceInfo?: Pick<TSkill, 'source'> };
};

/** A conditional replacement never creates a missing file or overwrites another revision. */
export function createSkillUploadHandler(
  deps: SkillUploadDeps,
): (req: UploadRequest, res: Response) => Promise<Response> {
  return async function uploadFileHandler(req: UploadRequest, res: Response): Promise<Response> {
    try {
      const { file } = req;
      if (!file) {
        return res.status(400).json({ error: 'No file provided' });
      }
      if (!req.user?.id) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      const userId = req.user.id;
      const skillId = String((req.params as { id: string }).id);
      const { relativePath, expectedFileId } = req.body;
      if (typeof relativePath !== 'string' || !relativePath) {
        return res.status(400).json({ error: 'relativePath is required in form body' });
      }
      if (relativePath.toUpperCase() === 'SKILL.MD') {
        return res
          .status(400)
          .json({ error: 'SKILL.md is reserved; update the skill body instead' });
      }
      if (validateRelativePath(relativePath).length > 0) {
        return res.status(400).json({ error: 'Invalid file path' });
      }
      if (expectedFileId !== undefined && (typeof expectedFileId !== 'string' || !expectedFileId)) {
        return res.status(400).json({ error: 'Invalid file revision' });
      }
      const pathParam = (req.params as { relativePath?: string | string[] }).relativePath;
      if (
        pathParam !== undefined &&
        (!expectedFileId || resolveSkillFilePathParam(pathParam) !== relativePath)
      ) {
        return res.status(400).json({ error: 'A matching path and file revision are required' });
      }
      // Privileged access can bypass the ACL resolver. Start both scoped reads
      // together, but do not write bytes until the source and revision are checked.
      const [skill, existingFile] = await Promise.all([
        req.resourceAccess?.resourceInfo ?? deps.getSkillById(skillId),
        deps.getSkillFileByPath(skillId, relativePath),
      ]);
      if (!skill) {
        return res.status(404).json({ error: 'Skill not found' });
      }
      if ((skill.source ?? 'inline') !== 'inline') {
        return res.status(403).json({ error: 'Externally managed skill files are read-only' });
      }
      if (
        blockFilteredSkillFile(req.config?.filters, res, {
          buffer: file.buffer,
          originalName: file.originalname,
          relativePath,
        })
      ) {
        return res;
      }
      if (expectedFileId != null && existingFile?.file_id !== expectedFileId) {
        return res.status(409).json({ error: 'SKILL_FILE_CONFLICT' });
      }
      const tenantId = resolveRequestTenantId(req);
      const storage = deps.resolveStorage(req, { isImage: file.mimetype.startsWith('image/') });
      const fileId = randomUUID();
      const filepath = await storage.saveBuffer({
        userId,
        buffer: file.buffer,
        fileName: `${fileId}__${file.originalname}`,
        basePath: 'uploads',
        tenantId,
      });
      const cleanupReplacedBlob = (): void => {
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
          }).catch((error: Error) => logger.error('[uploadFile] Old blob cleanup failed:', error));
        }
      };
      let result: StoredSkillFile;
      try {
        result = await deps.upsertSkillFile({
          skillId,
          relativePath,
          expectedFileId,
          file_id: fileId,
          filename: file.originalname,
          filepath,
          ...getStorageMetadata({ filepath, source: storage.source }),
          source: storage.source,
          mimeType: file.mimetype || 'application/octet-stream',
          bytes: file.size,
          isExecutable: existingFile?.isExecutable ?? false,
          author: userId,
          tenantId,
        });
      } catch (error) {
        try {
          // A parent-version update can fail after the file row committed. Never
          // delete its live blob on that ambiguous failure; retain it for reread.
          const persisted = await deps.getSkillFileByPath(skillId, relativePath);
          if (persisted?.file_id === fileId) {
            cleanupReplacedBlob();
          } else {
            await deps.getStrategyFunctions(storage.source).deleteFile?.(req, {
              filepath,
              ...getStorageMetadata({ filepath, source: storage.source }),
              user: userId,
              tenantId,
            });
          }
        } catch (cleanupError) {
          logger.error('[uploadFile] Failed to clean up orphaned blob:', cleanupError);
        }
        throw error;
      }
      cleanupReplacedBlob();
      return res.status(200).json(result);
    } catch (error) {
      if (error instanceof Error && 'code' in error) {
        if (error.code === 'SKILL_FILE_CONFLICT') {
          return res.status(409).json({ error: 'SKILL_FILE_CONFLICT' });
        }
        if (error.code === 'SKILL_FILE_VALIDATION_FAILED') {
          return res.status(400).json({ error: error.message });
        }
      }
      logger.error('[uploadFile] Error:', error);
      return res.status(500).json({ error: 'Failed to upload file' });
    }
  };
}
