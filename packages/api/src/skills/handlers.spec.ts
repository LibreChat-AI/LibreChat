import os from 'os';
import path from 'path';
import { Types } from 'mongoose';
import { promises as fs } from 'fs';
import type { ISkillFile } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { SkillDeletionProgress } from './deletion';
import type { SkillsHandlersDeps } from './handlers';
import type { ServerRequest } from '~/types';
import {
  createOwnedBlobFileDeleter,
  extractAzureBlobPath,
  extractFirebaseBlobPath,
} from '~/storage/ownedBlobDelete';
import { createLocalFileDeleter } from '~/storage/local';
import { createSkillsHandlers } from './handlers';

function mockResponse(): Response {
  const res = {} as Response;
  res.status = jest.fn(() => res) as Response['status'];
  res.json = jest.fn(() => res) as Response['json'];
  return res;
}

describe('skill delete handler', () => {
  function deletionHarness() {
    const id = new Types.ObjectId().toString();
    const complete: SkillDeletionProgress = {
      found: true,
      deleted: true,
      skillAbsent: true,
      cleanupComplete: true,
      failedSteps: [],
    };
    const deps = {
      deleteSkillById: jest.fn(async () => complete),
      isValidObjectIdString: jest.fn(() => true),
    };
    return { id, deps };
  }

  it('delegates deletion through the claimed service before returning success', async () => {
    const { id, deps } = deletionHarness();
    const handlers = createSkillsHandlers(deps as unknown as SkillsHandlersDeps);
    const req = { params: { id } } as unknown as ServerRequest;
    const res = mockResponse();

    await handlers.delete(req, res);

    expect(deps.deleteSkillById).toHaveBeenCalledWith(id);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ id, deleted: true, cleanupComplete: true });
  });

  it('leaves the deletion pending when non-file cleanup is incomplete', async () => {
    const { id, deps } = deletionHarness();
    deps.deleteSkillById.mockResolvedValueOnce({
      found: true,
      deleted: false,
      skillAbsent: false,
      cleanupComplete: false,
      failedSteps: ['permissions'],
    });
    const handlers = createSkillsHandlers(deps as unknown as SkillsHandlersDeps);
    const req = { params: { id } } as unknown as ServerRequest;
    const res = mockResponse();

    await handlers.delete(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ id, deleted: true, cleanupComplete: false });
  });

  it('reports pending cleanup when another worker holds the claim', async () => {
    const { id, deps } = deletionHarness();
    deps.deleteSkillById.mockResolvedValueOnce({
      found: true,
      deleted: false,
      skillAbsent: false,
      cleanupComplete: false,
      failedSteps: [],
    });
    const handlers = createSkillsHandlers(deps as unknown as SkillsHandlersDeps);
    const req = { params: { id } } as unknown as ServerRequest;
    const res = mockResponse();

    await handlers.delete(req, res);

    expect(deps.deleteSkillById).toHaveBeenCalledWith(id);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ id, deleted: true, cleanupComplete: false });
  });
});

describe.each([
  {
    source: 'azure_blob',
    filepath: 'https://example.blob.core.windows.net/files/uploads/author-1/file.txt',
    extractPath: (url: string) => extractAzureBlobPath(url, 'files'),
  },
  {
    source: 'firebase',
    filepath: 'https://firebasestorage.googleapis.com/v0/b/bucket/o/uploads%2Fauthor-1%2Ffile.txt',
    extractPath: extractFirebaseBlobPath,
  },
])(
  'cross-author Skill file deletion through $source storage',
  ({ source, filepath, extractPath }) => {
    it('deletes with the persisted author while the manager remains the requester', async () => {
      const skillId = new Types.ObjectId().toString();
      const file = {
        file_id: 'file-1',
        filepath,
        source,
        author: new Types.ObjectId(),
        relativePath: 'references/file.txt',
      } as ISkillFile & { _id: Types.ObjectId };
      const ownerId = file.author.toString();
      const ownedFilepath = filepath.replace('author-1', ownerId);
      file.filepath = ownedFilepath;
      const deleteBlob = jest.fn().mockResolvedValue(undefined);
      const deleteRagFile = jest.fn().mockResolvedValue(undefined);
      const storageDelete = createOwnedBlobFileDeleter({
        extractPath,
        deleteBlob,
        deleteRagFile,
        isMissing: () => false,
      });
      const deleteSkillFile = jest.fn().mockResolvedValue({ deleted: true });
      const storageDeleteSpy = jest.fn(storageDelete);
      const handlers = createSkillsHandlers({
        getSkillFileByPath: jest.fn().mockResolvedValue(file),
        getStrategyFunctions: jest.fn(() => ({ deleteFile: storageDeleteSpy })),
        deleteSkillFile,
      } as unknown as SkillsHandlersDeps);
      const req = {
        params: { id: skillId, relativePath: 'references/file.txt' },
        user: { id: 'manager-1', tenantId: 'tenant-1' },
      } as unknown as ServerRequest;
      const res = mockResponse();

      await handlers.deleteFile(req, res);

      expect(deleteBlob).toHaveBeenCalledWith(`uploads/${ownerId}/file.txt`);
      expect(deleteRagFile).toHaveBeenCalledWith({
        userId: ownerId,
        file: expect.objectContaining({ user: ownerId }),
      });
      expect(deleteSkillFile).toHaveBeenCalledWith(skillId, 'references/file.txt', 'file-1');
      expect(res.status).toHaveBeenCalledWith(200);
      expect(storageDeleteSpy.mock.calls[0][0]).toMatchObject({
        user: { id: ownerId, tenantId: 'tenant-1' },
      });
      expect(req.user).toEqual({ id: 'manager-1', tenantId: 'tenant-1' });
    });
  },
);

describe('Skill file storage ownership', () => {
  it('deletes a loaded cross-author Local file without changing the authenticated request', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-owner-'));
    try {
      const author = new Types.ObjectId();
      const ownerId = author.toString();
      const uploads = path.join(root, 'uploads');
      const diskPath = path.join(uploads, ownerId, 'file.txt');
      await fs.mkdir(path.dirname(diskPath), { recursive: true });
      await fs.writeFile(diskPath, 'contents');
      const file = {
        file_id: 'file-1',
        filepath: `/uploads/${ownerId}/file.txt`,
        source: 'local',
        author,
      } as ISkillFile & { _id: Types.ObjectId };
      const deleteRagFile = jest.fn().mockResolvedValue(undefined);
      const storageDelete = createLocalFileDeleter({
        deleteRagFile,
        logger: { warn: jest.fn(), error: jest.fn() },
      });
      const handlers = createSkillsHandlers({
        getSkillFileByPath: jest.fn().mockResolvedValue(file),
        getStrategyFunctions: () => ({ deleteFile: storageDelete }),
        deleteSkillFile: jest.fn().mockResolvedValue({ deleted: true }),
      } as unknown as SkillsHandlersDeps);
      const req = {
        params: { id: new Types.ObjectId().toString(), relativePath: 'file.txt' },
        user: { id: 'manager-1', tenantId: 'tenant-1' },
        config: { paths: { uploads, publicPath: path.join(root, 'public') } },
      } as unknown as ServerRequest;
      const res = mockResponse();

      await handlers.deleteFile(req, res);

      await expect(fs.access(diskPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(deleteRagFile).toHaveBeenCalledWith({
        userId: ownerId,
        file: expect.objectContaining({ user: ownerId }),
      });
      expect(req.user).toEqual({ id: 'manager-1', tenantId: 'tenant-1' });
      expect(res.status).toHaveBeenCalledWith(200);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each([undefined, ''])(
    'does not fall back to the manager for a missing author (%s)',
    async (author) => {
      const deleteBlob = jest.fn();
      const deleteSkillFile = jest.fn();
      const handlers = createSkillsHandlers({
        getSkillFileByPath: jest.fn().mockResolvedValue({
          file_id: 'file-1',
          filepath: '/uploads/manager-1/file.txt',
          source: 'local',
          author,
        }),
        getStrategyFunctions: () => ({ deleteFile: deleteBlob }),
        deleteSkillFile,
      } as unknown as SkillsHandlersDeps);
      const req = {
        params: { id: new Types.ObjectId().toString(), relativePath: 'file.txt' },
        user: { id: 'manager-1' },
      } as unknown as ServerRequest;
      const res = mockResponse();

      await handlers.deleteFile(req, res);

      expect(deleteBlob).not.toHaveBeenCalled();
      expect(deleteSkillFile).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(500);
    },
  );
});

describe('skill create handler', () => {
  it('retries dependent cleanup after owner permission setup fails', async () => {
    const skillId = new Types.ObjectId();
    const deleteSkill = jest
      .fn()
      .mockResolvedValueOnce({
        deleted: true,
        skillAbsent: true,
        cleanupComplete: false,
        failedCleanupSteps: ['permissions'],
      })
      .mockResolvedValueOnce({
        deleted: false,
        skillAbsent: true,
        cleanupComplete: true,
        failedCleanupSteps: [],
      });
    const handlers = createSkillsHandlers({
      createSkill: jest.fn(async () => ({
        skill: { _id: skillId, name: 'permission-failure' },
        warnings: [],
      })),
      grantPermission: jest.fn(async () => {
        throw new Error('permission unavailable');
      }),
      deleteSkill,
    } as unknown as SkillsHandlersDeps);
    const req = {
      body: { name: 'permission-failure', description: 'Rollback test', body: '# Test' },
      user: { id: 'user-1', _id: new Types.ObjectId(), name: 'Test User' },
    } as unknown as ServerRequest;
    const res = mockResponse();

    await handlers.create(req, res);

    expect(deleteSkill).toHaveBeenCalledTimes(2);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('skill file delete handler', () => {
  const id = new Types.ObjectId().toString();
  const file = {
    _id: new Types.ObjectId(),
    file_id: 'file-revision',
    relativePath: 'references/guide.md',
    filepath: '/uploads/guide.md',
    source: 'local',
    author: new Types.ObjectId(),
    tenantId: 'tenant-1',
  } as ISkillFile & { _id: Types.ObjectId };
  const req = {
    params: { id, relativePath: 'references/guide.md' },
    user: { id: 'manager-1', tenantId: 'tenant-1' },
  } as unknown as ServerRequest;

  it('waits for blob cleanup before conditionally deleting the file record', async () => {
    let releaseBlob!: () => void;
    const deleteBlob = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseBlob = resolve;
        }),
    );
    const deleteSkillFile = jest.fn(async () => ({ deleted: true }));
    const handlers = createSkillsHandlers({
      getSkillFileByPath: jest.fn(async () => file),
      deleteSkillFile,
      getStrategyFunctions: jest.fn(() => ({ deleteFile: deleteBlob })),
    } as unknown as SkillsHandlersDeps);
    const res = mockResponse();

    const pending = handlers.deleteFile(req, res);
    await Promise.resolve();
    expect(deleteSkillFile).not.toHaveBeenCalled();
    releaseBlob();
    await pending;

    expect(deleteSkillFile).toHaveBeenCalledWith(id, 'references/guide.md', 'file-revision');
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('keeps the file record retryable when blob cleanup fails', async () => {
    const deleteSkillFile = jest.fn();
    const handlers = createSkillsHandlers({
      getSkillFileByPath: jest.fn(async () => file),
      deleteSkillFile,
      getStrategyFunctions: jest.fn(() => ({
        deleteFile: jest.fn(async () => {
          throw new Error('storage unavailable');
        }),
      })),
    } as unknown as SkillsHandlersDeps);
    const res = mockResponse();

    await handlers.deleteFile(req, res);

    expect(deleteSkillFile).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('reports a conflict when a concurrent writer replaces the path', async () => {
    const handlers = createSkillsHandlers({
      getSkillFileByPath: jest.fn(async () => file),
      deleteSkillFile: jest.fn(async () => ({ deleted: false })),
      getStrategyFunctions: jest.fn(() => ({ deleteFile: jest.fn(async () => undefined) })),
    } as unknown as SkillsHandlersDeps);
    const res = mockResponse();

    await handlers.deleteFile(req, res);

    expect(res.status).toHaveBeenCalledWith(409);
  });

  it('reports a conflict when whole-Skill deletion starts before the file row is removed', async () => {
    const deleteBlob = jest.fn(async () => undefined);
    const handlers = createSkillsHandlers({
      getSkillFileByPath: jest.fn(async () => file),
      deleteSkillFile: jest.fn(async () => {
        throw Object.assign(new Error('Skill is being deleted'), { code: 'SKILL_DELETING' });
      }),
      getStrategyFunctions: jest.fn(() => ({ deleteFile: deleteBlob })),
    } as unknown as SkillsHandlersDeps);
    const res = mockResponse();

    await handlers.deleteFile(req, res);

    expect(deleteBlob).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({ error: 'SKILL_DELETING' });
  });
});
