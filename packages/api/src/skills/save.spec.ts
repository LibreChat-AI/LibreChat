import { Types } from 'mongoose';
import { FileSources } from 'librechat-data-provider';
import type { SaveBufferParams } from '~/storage/types';
import { createSkillFileSaver, createSkillManagementFileSaver } from './save';

type SaverDeps = Parameters<typeof createSkillFileSaver>[0];

const existing = {
  file_id: 'initial',
  filepath: '/uploads/initial',
  source: 'local',
  author: { toString: () => 'original-owner' },
  tenantId: 'original-tenant',
  isExecutable: true,
  bytes: 8,
  relativePath: 'references/a.md',
};

function harness() {
  const saveBuffer = jest.fn(
    async (input: SaveBufferParams) => `/uploads/${input.userId}/${input.fileName}`,
  );
  const deleteFile = jest.fn(async () => undefined);
  const getSkillFileByPath = jest.fn(
    async (): ReturnType<SaverDeps['getSkillFileByPath']> => existing,
  );
  const upsertSkillFile = jest.fn(
    async (
      row: Parameters<SaverDeps['upsertSkillFile']>[0],
    ): ReturnType<SaverDeps['upsertSkillFile']> => ({
      ...existing,
      file_id: row.file_id,
      filepath: row.filepath,
      bytes: 9,
    }),
  );
  const deps = {
    getSkillFileByPath,
    upsertSkillFile,
    resolveStorage: jest.fn(() => ({ source: FileSources.local, saveBuffer })),
    getStrategyFunctions: jest.fn(() => ({ deleteFile })),
    reserveSkillUploadIntent: jest.fn(async (input) => ({
      ...input,
      skillId: new Types.ObjectId(),
      author: new Types.ObjectId(),
      state: 'uploading' as const,
    })),
    transitionSkillUploadIntent: jest.fn(async () => true),
  } satisfies SaverDeps;
  const req = { user: { id: 'editor', _id: 'editor' }, config: {} } as never;
  const params = {
    req,
    skillId: 'skill-id',
    relativePath: 'references/a.md',
    content: 'new text\n',
    mimeType: 'text/markdown',
    expectedFileId: 'initial',
    createOnly: false,
  };
  const { req: request, skillId, relativePath, content, mimeType } = params;
  return {
    deps,
    params,
    managementParams: { req: request, skillId, relativePath, content, mimeType },
    saveBuffer,
    deleteFile,
    getSkillFileByPath,
    upsertSkillFile,
    save: createSkillFileSaver(deps),
    saveManagement: createSkillManagementFileSaver(deps),
  };
}

describe('management skill file saver', () => {
  it('leaves superseded blob cleanup to the durable persistence queue', async () => {
    const h = harness();
    await h.saveManagement(h.managementParams);
    expect(h.deleteFile).not.toHaveBeenCalled();
  });
  it('creates a missing path with an insert-only write and no second lookup', async () => {
    const h = harness();
    h.getSkillFileByPath.mockResolvedValueOnce(null);
    await expect(h.saveManagement(h.managementParams)).resolves.toEqual({
      bytes: 9,
      relativePath: 'references/a.md',
    });
    expect(h.getSkillFileByPath).toHaveBeenCalledTimes(1);
    expect(h.upsertSkillFile).toHaveBeenCalledWith(
      expect.objectContaining({ createOnly: true, expectedFileId: undefined }),
    );
    expect(h.deleteFile).not.toHaveBeenCalled();
  });

  it('matches the current stored revision when replacing a file with complete content', async () => {
    const h = harness();
    await expect(h.saveManagement(h.managementParams)).resolves.toEqual({
      bytes: 9,
      relativePath: 'references/a.md',
    });
    expect(h.getSkillFileByPath).toHaveBeenCalledTimes(1);
    expect(h.upsertSkillFile).toHaveBeenCalledWith(
      expect.objectContaining({ createOnly: false, expectedFileId: 'initial' }),
    );
    expect(h.deleteFile).not.toHaveBeenCalled();
  });

  it('rejects and removes only its upload if a concurrent browser edit wins', async () => {
    const h = harness();
    h.upsertSkillFile.mockRejectedValueOnce(
      Object.assign(new Error('browser won the write'), { code: 'SKILL_FILE_CONFLICT' }),
    );
    h.getSkillFileByPath
      .mockResolvedValueOnce(existing)
      .mockResolvedValueOnce({ ...existing, file_id: 'browser', filepath: '/uploads/browser' });
    await expect(h.saveManagement(h.managementParams)).rejects.toMatchObject({
      code: 'SKILL_FILE_CONFLICT',
    });
    expect(h.upsertSkillFile).toHaveBeenCalledWith(
      expect.objectContaining({ createOnly: false, expectedFileId: 'initial' }),
    );
    expect(h.deleteFile).toHaveBeenCalledTimes(1);
    expect(h.deleteFile).toHaveBeenCalledWith(
      h.params.req,
      expect.objectContaining({
        filepath: expect.stringMatching(/^\/uploads\/editor\//),
        user: 'editor',
      }),
    );
  });
});

describe('agent skill file saver', () => {
  it('rejects an obsolete or absent revision before writing bytes', async () => {
    const h = harness();
    await expect(h.save({ ...h.params, expectedFileId: 'stale' })).rejects.toMatchObject({
      code: 'SKILL_FILE_CONFLICT',
    });
    await expect(h.save({ ...h.params, expectedFileId: undefined })).rejects.toMatchObject({
      code: 'SKILL_FILE_CONFLICT',
    });
    expect(h.saveBuffer).not.toHaveBeenCalled();
    expect(h.upsertSkillFile).not.toHaveBeenCalled();
  });

  it('inserts only when absent and forwards creation-only intent to Mongo', async () => {
    const h = harness();
    await expect(
      h.save({ ...h.params, expectedFileId: undefined, createOnly: true }),
    ).rejects.toMatchObject({
      code: 'SKILL_FILE_CONFLICT',
    });
    h.getSkillFileByPath.mockResolvedValueOnce(null);
    await expect(
      h.save({ ...h.params, expectedFileId: undefined, createOnly: true }),
    ).resolves.toEqual({
      bytes: 9,
      relativePath: 'references/a.md',
    });
    expect(h.upsertSkillFile).toHaveBeenCalledWith(
      expect.objectContaining({ createOnly: true, expectedFileId: undefined }),
    );
  });

  it('preserves executable metadata and queues the original blob through persistence', async () => {
    const h = harness();
    await expect(h.save(h.params)).resolves.toEqual({
      bytes: 9,
      relativePath: 'references/a.md',
    });
    expect(h.upsertSkillFile).toHaveBeenCalledWith(
      expect.objectContaining({ expectedFileId: 'initial', createOnly: false, isExecutable: true }),
    );
    expect(h.deleteFile).not.toHaveBeenCalled();
    expect(h.deleteFile).not.toHaveBeenCalledWith(
      h.params.req,
      expect.objectContaining({ filepath: '/uploads/new' }),
    );
  });

  it('deletes only the losing upload when the browser wins after storage starts', async () => {
    const h = harness();
    h.upsertSkillFile.mockRejectedValueOnce(
      Object.assign(new Error('browser won the race'), { code: 'SKILL_FILE_CONFLICT' }),
    );
    h.getSkillFileByPath.mockResolvedValueOnce(existing).mockResolvedValueOnce({
      ...existing,
      file_id: 'browser-winner',
      filepath: '/uploads/browser',
    });
    await expect(h.save(h.params)).rejects.toMatchObject({ code: 'SKILL_FILE_CONFLICT' });
    expect(h.deleteFile).toHaveBeenCalledWith(
      h.params.req,
      expect.objectContaining({
        filepath: expect.stringMatching(/^\/uploads\/editor\//),
        user: 'editor',
      }),
    );
    expect(h.deleteFile).not.toHaveBeenCalledWith(
      h.params.req,
      expect.objectContaining({ filepath: '/uploads/browser' }),
    );
  });

  it('retains committed bytes if the parent bump fails', async () => {
    const h = harness();
    let committedRevision = '';
    h.upsertSkillFile.mockImplementationOnce(async (row) => {
      committedRevision = row.file_id;
      throw new Error('parent update failed');
    });
    h.getSkillFileByPath.mockResolvedValueOnce(existing).mockImplementation(async () => ({
      ...existing,
      file_id: committedRevision,
      filepath: '/uploads/editor/committed',
    }));
    await expect(h.save(h.params)).resolves.toEqual({
      bytes: h.params.content.length,
      relativePath: h.params.relativePath,
    });
    expect(committedRevision).not.toBe('');
    expect(h.deleteFile).not.toHaveBeenCalled();
    expect(h.deleteFile).not.toHaveBeenCalledWith(
      h.params.req,
      expect.objectContaining({ filepath: '/uploads/new' }),
    );
  });

  it('deletes an unreferenced upload when Mongo does not return a saved row', async () => {
    const h = harness();
    h.getSkillFileByPath.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    h.upsertSkillFile.mockResolvedValueOnce(null);
    await expect(
      h.save({ ...h.params, expectedFileId: undefined, createOnly: true }),
    ).rejects.toMatchObject({
      code: 'SKILL_FILE_UPSERT_NOT_FOUND',
    });
    expect(h.deleteFile).toHaveBeenCalledWith(
      h.params.req,
      expect.objectContaining({
        filepath: expect.stringMatching(/^\/uploads\/editor\//),
        user: 'editor',
      }),
    );
  });
});
