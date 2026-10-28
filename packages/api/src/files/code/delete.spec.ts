import type { CodeEnvRef } from 'librechat-data-provider';
import type { ServerRequest } from '~/types';
import { createFileProvisionRecovery } from '../operations';
import { createCodeFileDeleter } from './delete';

const req = { user: { id: 'owner' } } as ServerRequest;
const ref: CodeEnvRef = {
  kind: 'user',
  id: 'owner',
  file_id: 'remote-copy',
  storage_session_id: 'session',
  provisionedAt: Date.now(),
};

function setup() {
  const httpClient = jest.fn().mockResolvedValue({ status: 204 });
  const clearFileCodeEnvRefs = jest.fn().mockResolvedValue(true);
  const remove = createCodeFileDeleter({
    httpClient,
    clearFileCodeEnvRefs,
    getAuthHeaders: jest.fn().mockResolvedValue({}),
    getBaseUrl: jest.fn(() => 'https://code.example'),
    routeKey: jest.fn(() => 'default'),
    profileHeaders: jest.fn(() => ({})),
    downloadQuery: jest.fn(() => '?kind=user&id=owner'),
    logger: { warn: jest.fn() },
  });
  return { httpClient, clearFileCodeEnvRefs, remove };
}

it.each([204, 404])('reconciles a confirmed code deletion or absence (%s)', async (status) => {
  const { httpClient, clearFileCodeEnvRefs, remove } = setup();
  if (status === 404) httpClient.mockRejectedValue({ response: { status } });
  const file = { file_id: 'stored-file', metadata: { codeEnvRefs: { default: ref } } };
  await expect(remove(req, file)).resolves.toEqual({ deleted: true });
  expect(clearFileCodeEnvRefs).toHaveBeenCalledWith({
    file_id: 'stored-file',
    userId: 'owner',
    tenantId: undefined,
    refs: [{ routeKey: 'default', ref }],
  });
  expect(file.metadata.codeEnvRefs.default).toBe(ref);
});

it('persists each confirmed route before a later route fails', async () => {
  const { httpClient, clearFileCodeEnvRefs, remove } = setup();
  httpClient
    .mockResolvedValueOnce({ status: 204 })
    .mockRejectedValueOnce(new Error('code offline'));
  const other: CodeEnvRef = { ...ref, executionProfile: 'stateful', file_id: 'other-copy' };
  await expect(
    remove(req, {
      file_id: 'stored-file',
      metadata: { codeEnvRefs: { default: ref, stateful: other } },
    }),
  ).rejects.toThrow('code offline');
  expect(clearFileCodeEnvRefs).toHaveBeenCalledTimes(1);
  expect(clearFileCodeEnvRefs.mock.invocationCallOrder[0]).toBeLessThan(
    httpClient.mock.invocationCallOrder[1],
  );
});

it.each(['conflict', 'failure'])(
  'does not forgive code reconciliation %s as storage absence',
  async (mode) => {
    const { clearFileCodeEnvRefs, remove } = setup();
    if (mode === 'conflict') clearFileCodeEnvRefs.mockResolvedValue(false);
    else clearFileCodeEnvRefs.mockRejectedValue(new Error('resource not found'));
    await expect(
      remove(req, { file_id: 'stored-file', metadata: { codeEnvRef: ref } }),
    ).rejects.toThrow('Code storage reconciliation failed');
  },
);

it('does not confirm or invalidate an unmapped historical route', async () => {
  const { httpClient, clearFileCodeEnvRefs, remove } = setup();
  const route = 'stateful:0123456789abcdef0123456789abcdef';
  await expect(
    remove(req, {
      file_id: 'stored-file',
      metadata: {
        codeEnvRefs: {
          [route]: { ...ref, executionProfile: 'stateful', executionRouteKey: route },
        },
      },
    }),
  ).resolves.toBeUndefined();
  expect(httpClient).not.toHaveBeenCalled();
  expect(clearFileCodeEnvRefs).not.toHaveBeenCalled();
});

it('invalidates a confirmed code pointer even when a later vector deletion fails', async () => {
  const { createDeleteFileWithSecondaryStorage } = await import('../storage');
  const { FileSources } = await import('librechat-data-provider');
  const { clearFileCodeEnvRefs, remove } = setup();
  const retained = {
    file_id: 'stored-file',
    embedded: true,
    metadata: { codeEnvRef: ref },
  };
  const primary = jest.fn();
  const clearFileEmbeddings = jest.fn();
  const deleteFile = createDeleteFileWithSecondaryStorage({
    source: FileSources.local,
    deleteFile: primary,
    getDeleteFile: (source) =>
      source === FileSources.execute_code
        ? async () => remove(req, retained)
        : async () => {
            throw new Error('vector unavailable');
          },
    clearFileEmbeddings,
    isFileStorageClean: jest.fn().mockResolvedValue(true),
    fileStorage: {
      recovery: createFileProvisionRecovery(),
      acquireFileProvision: jest.fn().mockResolvedValue(true),
      releaseFileProvision: jest.fn().mockResolvedValue(true),
      commitFileProvision: jest.fn().mockResolvedValue(true),
      acquireFileDeletion: jest.fn().mockResolvedValue({ resumed: false }),
      releaseFileDeletion: jest.fn().mockResolvedValue(true),
    },
    logger: { warn: jest.fn() },
  });
  await expect(
    deleteFile(
      {
        user: { id: 'owner' },
        config: { fileConfig: { retainedFileCleanup: true } },
      },
      retained,
    ),
  ).rejects.toThrow('vector unavailable');
  expect(clearFileCodeEnvRefs).toHaveBeenCalledWith(
    expect.objectContaining({
      file_id: 'stored-file',
      refs: [{ routeKey: 'default', ref }],
    }),
  );
  expect(primary).not.toHaveBeenCalled();
  expect(clearFileEmbeddings).not.toHaveBeenCalled();
});
