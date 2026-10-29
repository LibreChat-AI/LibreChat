import { commitExtractionUpload, createExtractionUploadPersistence } from './commit';

function fixture(selected = true) {
  const response = { destroyed: false, writableFinished: false };
  const persistence = createExtractionUploadPersistence({ response });
  if (selected) persistence.select();
  const deleteFile = jest.fn(async () => undefined);
  const recordExists = jest.fn(async () => false);
  const addAgentResourceFile = jest.fn(async (): Promise<void> => {});
  const removeAgentResourceFiles = jest.fn(async () => undefined);
  const createFile = jest.fn(async () => ({ file_id: 'new-upload' }));
  const logger = { error: jest.fn() };
  const options = {
    persistence,
    cleanup: {
      req: { user: { id: 'user', tenantId: 'tenant' } },
      logger,
      stored: { file_id: 'new-upload', filepath: '/uploads/user/new.pdf', source: 'local' },
      resolveDeleteFile: () => deleteFile,
      recordExists,
    },
    resource: {
      agent_id: 'agent',
      tool_resource: 'context',
      file_id: 'new-upload',
      updatingUserId: 'user',
    },
    messageAttachment: false,
    addAgentResourceFile,
    removeAgentResourceFiles,
    createFile,
  };
  return { ...options, options, response, deleteFile, recordExists, logger };
}

describe('selected extraction upload persistence', () => {
  it('rejects cancellation before resource mutation and cleans only request-owned bytes', async () => {
    const f = fixture();
    f.response.destroyed = true;
    await expect(commitExtractionUpload(f.options)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(f.addAgentResourceFile).not.toHaveBeenCalled();
    expect(f.createFile).not.toHaveBeenCalled();
    expect(f.recordExists).not.toHaveBeenCalled();
    expect(f.deleteFile).toHaveBeenCalledWith(f.cleanup.req, {
      ...f.cleanup.stored,
      user: 'user',
      tenantId: 'tenant',
    });
  });

  it('rechecks cancellation after a paused retention read', async () => {
    const f = fixture();
    let finish: () => void = () => {};
    const retention = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const waiting = f.persistence.wait(retention);
    f.response.destroyed = true;
    finish();
    await expect(waiting).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(f.createFile).not.toHaveBeenCalled();
  });

  it('drains storage cleanup before returning cancellation', async () => {
    const f = fixture();
    let release: () => void = () => {};
    let settled = false;
    f.deleteFile.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          release = () => resolve(undefined);
        }),
    );
    f.response.destroyed = true;
    const pending = commitExtractionUpload(f.options).catch((error) => {
      settled = true;
      return error;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(f.deleteFile).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    release();
    await expect(pending).resolves.toMatchObject({ code: 'CANCELLED' });
  });

  it('compensates only the staged resource link if cancellation arrives during its write', async () => {
    const f = fixture();
    let finish: () => void = () => {};
    f.addAgentResourceFile.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = commitExtractionUpload(f.options);
    f.response.destroyed = true;
    finish();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(f.createFile).not.toHaveBeenCalled();
    expect(f.recordExists).not.toHaveBeenCalled();
    expect(f.removeAgentResourceFiles).toHaveBeenCalledWith({
      agent_id: 'agent',
      files: [{ tool_resource: 'context', file_id: 'new-upload' }],
    });
    expect(f.deleteFile).toHaveBeenCalledTimes(1);
    expect(f.removeAgentResourceFiles.mock.invocationCallOrder[0]).toBeLessThan(
      f.deleteFile.mock.invocationCallOrder[0],
    );
  });

  it('compensates a failed resource write without starting the file write', async () => {
    const f = fixture();
    f.addAgentResourceFile.mockRejectedValueOnce(new Error('lost acknowledgement'));
    await expect(commitExtractionUpload(f.options)).rejects.toThrow('lost acknowledgement');
    expect(f.removeAgentResourceFiles).toHaveBeenCalledTimes(1);
    expect(f.createFile).not.toHaveBeenCalled();
    expect(f.deleteFile).toHaveBeenCalledTimes(1);
  });

  it('still removes unreferenced bytes when staging compensation fails', async () => {
    const f = fixture();
    f.addAgentResourceFile.mockImplementationOnce(async () => {
      f.response.destroyed = true;
    });
    f.removeAgentResourceFiles.mockRejectedValueOnce(new Error('agent unavailable'));
    await expect(commitExtractionUpload(f.options)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(f.createFile).not.toHaveBeenCalled();
    expect(f.logger.error).toHaveBeenCalledTimes(1);
    expect(f.deleteFile).toHaveBeenCalledTimes(1);
  });

  it('keeps an acknowledged file commit and its resource on a late disconnect, without returning success', async () => {
    const f = fixture();
    let finish: (value: { file_id: string }) => void = () => {};
    f.createFile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = commitExtractionUpload(f.options);
    await Promise.resolve();
    expect(f.createFile).toHaveBeenCalledTimes(1);
    f.response.destroyed = true;
    finish({ file_id: 'new-upload' });
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(f.recordExists).not.toHaveBeenCalled();
    expect(f.removeAgentResourceFiles).not.toHaveBeenCalled();
    expect(f.deleteFile).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'reconciles an ambiguous record write before cleanup (committed=%s)',
    async (committed) => {
      const f = fixture();
      f.recordExists.mockResolvedValueOnce(committed);
      f.createFile.mockRejectedValueOnce(new Error('lost acknowledgement'));
      await expect(commitExtractionUpload(f.options)).rejects.toThrow('lost acknowledgement');
      expect(f.recordExists).toHaveBeenCalledTimes(1);
      expect(f.removeAgentResourceFiles).toHaveBeenCalledTimes(committed ? 0 : 1);
      expect(f.deleteFile).toHaveBeenCalledTimes(committed ? 0 : 1);
    },
  );

  it('retains bytes and resource when the database cannot reconcile an ambiguous commit', async () => {
    const f = fixture();
    f.recordExists.mockRejectedValueOnce(new Error('database unavailable'));
    f.createFile.mockRejectedValueOnce(new Error('lost acknowledgement'));
    await expect(commitExtractionUpload(f.options)).rejects.toThrow('lost acknowledgement');
    expect(f.logger.error).toHaveBeenCalledTimes(1);
    expect(f.removeAgentResourceFiles).not.toHaveBeenCalled();
    expect(f.deleteFile).not.toHaveBeenCalled();
  });

  it('does not stage an agent link for a message attachment', async () => {
    const f = fixture();
    await expect(
      commitExtractionUpload({ ...f.options, messageAttachment: true }),
    ).resolves.toEqual({ file_id: 'new-upload' });
    expect(f.addAgentResourceFile).not.toHaveBeenCalled();
    expect(f.removeAgentResourceFiles).not.toHaveBeenCalled();
  });

  it('preserves nonselected legacy behavior on a closed response', async () => {
    const f = fixture(false);
    f.response.destroyed = true;
    await expect(commitExtractionUpload(f.options)).resolves.toEqual({ file_id: 'new-upload' });
    expect(f.addAgentResourceFile).toHaveBeenCalledTimes(1);
    expect(f.createFile).toHaveBeenCalledTimes(1);
  });
});
