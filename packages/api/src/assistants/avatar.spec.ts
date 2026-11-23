import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { FileContext } from 'librechat-data-provider';
import { createLocalFileDeleter } from '../storage/local';
import { commitAssistantAvatar } from './avatar';

const owner = '65cfb246f7ecadb8b1e8036c';
const manager = '65cfb246f7ecadb8b1e8036b';
const oldAvatar = { filepath: `/images/${owner}/old.png`, source: 'local' };
const newAvatar = { filepath: `/images/${manager}/new.png`, source: 'local' };
const oldFile = {
  file_id: 'old-file',
  filepath: oldAvatar.filepath,
  user: owner,
  tenantId: 'tenant-a',
  source: 'local',
};

function setup() {
  const deleteFile = jest.fn().mockResolvedValue(undefined);
  const leases = new Map<string, string>();
  const deps = {
    lease: {
      acquireResourceLock: jest.fn(async ({ key, ownerId }: { key: string; ownerId: string }) => {
        if (leases.has(key)) return false;
        leases.set(key, ownerId);
        return true;
      }),
      renewResourceLock: jest.fn(
        async ({ key, ownerId }: { key: string; ownerId: string }) => leases.get(key) === ownerId,
      ),
      releaseResourceLock: jest.fn(async ({ key, ownerId }: { key: string; ownerId: string }) => {
        if (leases.get(key) !== ownerId) return false;
        leases.delete(key);
        return true;
      }),
    },
    updateAssistantAvatar: jest.fn().mockResolvedValue({ previousAvatar: oldAvatar }),
    updateProvider: jest.fn().mockResolvedValue({ id: 'asst-target', metadata: {} }),
    getFiles: jest.fn().mockResolvedValue([oldFile]),
    deleteFileByFilter: jest.fn().mockResolvedValue(oldFile),
    getStrategyFunctions: jest.fn().mockReturnValue({ deleteFile }),
  };
  const req = {
    user: { id: manager, tenantId: 'tenant-a' },
    config: { paths: { publicPath: '', uploads: '' } },
  };
  const input = {
    req,
    query: { assistantId: 'asst-target' },
    identity: { user: owner, endpoint: 'assistants' },
    uploadAvatar: jest.fn().mockResolvedValue(newAvatar),
    metadata: { author: owner },
  };
  return { deps, deleteFile, req, input };
}

describe('assistant avatar commit and cleanup', () => {
  it('deletes using the persisted file owner only after both writes succeed', async () => {
    const { deps, deleteFile, input } = setup();
    const order: string[] = [];
    deps.updateAssistantAvatar.mockImplementation(async () => {
      order.push('database');
      return { previousAvatar: oldAvatar };
    });
    deps.updateProvider.mockImplementation(async () => {
      order.push('provider');
      return { id: 'asst-target' };
    });
    deleteFile.mockImplementation(async () => {
      order.push('blob');
    });
    deps.deleteFileByFilter.mockImplementation(async () => {
      order.push('file-row');
      return oldFile;
    });

    await expect(commitAssistantAvatar(input, deps)).resolves.toEqual({ id: 'asst-target' });
    expect(order).toEqual(['database', 'provider', 'blob', 'file-row']);
    expect(deps.getFiles).toHaveBeenCalledWith(
      { filepath: oldAvatar.filepath, context: FileContext.avatar },
      null,
      null,
      2,
    );
    expect(deleteFile).toHaveBeenCalledWith(
      expect.objectContaining({ user: { id: owner, _id: owner, tenantId: 'tenant-a' } }),
      oldFile,
    );
    expect(input.req.user.id).toBe(manager);
    expect(deps.deleteFileByFilter).toHaveBeenCalledWith({
      file_id: oldFile.file_id,
      filepath: oldFile.filepath,
      user: owner,
    });
  });

  it('removes an actual local avatar from the old owner namespace', async () => {
    const { deps, input } = setup();
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'assistant-cleanup-'));
    try {
      const oldPath = path.join(directory, 'images', owner, 'old.png');
      await fs.mkdir(path.dirname(oldPath), { recursive: true });
      await fs.writeFile(oldPath, 'old-avatar');
      input.req.config.paths = { publicPath: directory, uploads: path.join(directory, 'uploads') };
      const deleteRagFile = jest.fn().mockResolvedValue(undefined);
      const deleteFile = createLocalFileDeleter({
        deleteRagFile,
        logger: { warn: jest.fn(), error: jest.fn() },
      });
      deps.getStrategyFunctions.mockReturnValue({ deleteFile });
      await commitAssistantAvatar(input, deps);
      await expect(fs.stat(oldPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(deleteRagFile).toHaveBeenCalledWith({ userId: owner, file: oldFile });
      expect(deps.deleteFileByFilter).toHaveBeenCalled();
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it.each(['reject', 'missing'])(
    'preserves old storage and skips the provider on failed persistence: %s',
    async (failure) => {
      const { deps, deleteFile, input } = setup();
      if (failure === 'reject')
        deps.updateAssistantAvatar.mockRejectedValue(new Error('identity changed'));
      else deps.updateAssistantAvatar.mockResolvedValue(null);
      await expect(commitAssistantAvatar(input, deps)).rejects.toThrow();
      expect(deps.updateProvider).not.toHaveBeenCalled();
      expect(deps.getFiles).not.toHaveBeenCalled();
      expect(deleteFile).not.toHaveBeenCalled();
      expect(deps.deleteFileByFilter).not.toHaveBeenCalled();
    },
  );

  it('does not remove the old file if the provider update fails', async () => {
    const { deps, deleteFile, input } = setup();
    deps.updateProvider.mockRejectedValue(new Error('provider unavailable'));
    await expect(commitAssistantAvatar(input, deps)).rejects.toThrow('provider unavailable');
    expect(deleteFile).not.toHaveBeenCalled();
    expect(deps.deleteFileByFilter).not.toHaveBeenCalled();
  });

  it('never treats provider metadata as authority to delete another file', async () => {
    const { deps, deleteFile, input } = setup();
    deps.updateAssistantAvatar.mockResolvedValue({});
    await commitAssistantAvatar(
      { ...input, metadata: { avatar: oldFile.filepath, avatar_source: 'local' } },
      deps,
    );
    expect(deps.getFiles).not.toHaveBeenCalled();
    expect(deleteFile).not.toHaveBeenCalled();
  });

  it.each([
    null,
    [],
    [oldFile, oldFile],
    [{ ...oldFile, user: undefined }],
    [{ ...oldFile, tenantId: 'tenant-b' }],
    [{ ...oldFile, source: 's3' }],
  ])('does not delete an ambiguous or mismatched stored file: %p', async (files) => {
    const { deps, deleteFile, input } = setup();
    deps.getFiles.mockResolvedValue(files);
    await commitAssistantAvatar(input, deps);
    expect(deleteFile).not.toHaveBeenCalled();
    expect(deps.deleteFileByFilter).not.toHaveBeenCalled();
  });

  it('retains the file row for retry when storage deletion fails', async () => {
    const { deps, deleteFile, input } = setup();
    deleteFile.mockRejectedValue(new Error('storage unavailable'));
    await expect(commitAssistantAvatar(input, deps)).resolves.toEqual({
      id: 'asst-target',
      metadata: {},
    });
    expect(deps.deleteFileByFilter).not.toHaveBeenCalled();
  });

  it('does not delete an unchanged avatar path', async () => {
    const { deps, deleteFile, input } = setup();
    await commitAssistantAvatar({ ...input, uploadAvatar: async () => oldAvatar }, deps);
    expect(deleteFile).not.toHaveBeenCalled();
  });
});

it('does not delete the final provider avatar when successful replacements overlap', async () => {
  const { deps, input } = setup();
  let localAvatar = oldAvatar;
  let providerAvatar = oldAvatar.filepath;
  const removed = new Set<string>();
  let finishFirst: () => void = () => undefined;
  let signalFirst: () => void = () => undefined;
  const firstStarted = new Promise<void>((resolve) => {
    signalFirst = resolve;
  });
  const firstResponse = new Promise<void>((resolve) => {
    finishFirst = resolve;
  });
  const secondAvatar = { filepath: `/images/${owner}/second.png`, source: 'local' };
  deps.updateAssistantAvatar.mockImplementation(async (_query, nextAvatar) => {
    const previousAvatar = localAvatar;
    localAvatar = nextAvatar;
    return { previousAvatar };
  });
  deps.updateProvider.mockImplementation(async (_id, { metadata }) => {
    if (metadata.avatar === newAvatar.filepath) {
      signalFirst();
      await firstResponse;
    }
    providerAvatar = metadata.avatar;
    return { id: 'asst-target', metadata };
  });
  deps.getFiles.mockImplementation(async ({ filepath }) => [{ ...oldFile, filepath }]);
  deps.getStrategyFunctions.mockReturnValue({
    deleteFile: jest.fn(async (_req, file) => {
      removed.add(file.filepath);
    }),
  });
  const first = commitAssistantAvatar(input, deps);
  await firstStarted;
  const second = commitAssistantAvatar({ ...input, uploadAvatar: async () => secondAvatar }, deps);
  setTimeout(finishFirst, 5);
  await Promise.all([first, second]);
  expect(removed.has(providerAvatar)).toBe(false);
  expect(providerAvatar).toBe(localAvatar.filepath);
});

it('does not write or delete when another request holds the avatar lease', async () => {
  const { deps, input, deleteFile } = setup();
  deps.lease.acquireResourceLock.mockResolvedValue(false);
  await expect(
    commitAssistantAvatar({ ...input, leaseOptions: { waitMs: 0 } }, deps),
  ).rejects.toMatchObject({ statusCode: 409 });
  expect(input.uploadAvatar).not.toHaveBeenCalled();
  expect(deps.updateAssistantAvatar).not.toHaveBeenCalled();
  expect(deps.updateProvider).not.toHaveBeenCalled();
  expect(deleteFile).not.toHaveBeenCalled();
});

it('does not update the provider when its avatar lease is lost', async () => {
  const { deps, input, deleteFile } = setup();
  deps.lease.renewResourceLock.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(commitAssistantAvatar(input, deps)).rejects.toMatchObject({ statusCode: 409 });
  expect(deps.updateProvider).not.toHaveBeenCalled();
  expect(deleteFile).not.toHaveBeenCalled();
  expect(deps.lease.releaseResourceLock).toHaveBeenCalledTimes(1);
});
