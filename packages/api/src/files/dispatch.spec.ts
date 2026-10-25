import type { FileStorageClaim } from '@librechat/data-schemas';
import type { FileStorageUploadObserver } from './operations';
import {
  createCodeApiRateLimitBudget,
  createCodeApiUploadRegistry,
  withCodeApiUploadRecovery,
} from '../utils/code';
import { createFileProvisionRecovery, withFileDeletion, withFileProvisioning } from './operations';
import { dispatchFileDeletion, dispatchFileStorageOperation } from './dispatch';

function fixture() {
  const claims = new Set<string>();
  const storage = {
    recovery: createFileProvisionRecovery(),
    acquireFileProvision: jest.fn(async ({ token }: { token: string }) => {
      claims.add(token);
      return true;
    }),
    releaseFileProvision: jest.fn(async ({ token }: { token: string }) => {
      claims.delete(token);
      return true;
    }),
    commitFileProvision: jest.fn(async () => true),
    acquireFileDeletion: jest.fn(async () => (claims.size ? null : { resumed: false })),
    releaseFileDeletion: jest.fn(async () => true),
  };
  return { storage, file: { file_id: 'file', user: 'owner' }, claims };
}

it('marks each definitive rejection without treating a later canceled wait as an upload', async () => {
  const { storage, file, claims } = fixture();
  const controller = new AbortController();
  const rejected = Object.assign(new Error('throttled'), {
    isAxiosError: true,
    response: { status: 429, headers: { 'retry-after': '1' } },
  });
  const remote = jest.fn(async () => {
    throw rejected;
  });
  const operation = jest.fn(
    async (_claim: FileStorageClaim, onUploadStart: FileStorageUploadObserver) => {
      await withCodeApiUploadRecovery({
        registry: createCodeApiUploadRegistry(),
        scope: 'route:user',
        label: 'upload',
        budget: createCodeApiRateLimitBudget(10000),
        signal: controller.signal,
        onWait: () => controller.abort(),
        openSource: async () => 'source',
        upload: () => dispatchFileStorageOperation(onUploadStart, remote),
      });
      return { value: 'uploaded', commit: { embedded: true } };
    },
  );
  await expect(
    withFileProvisioning({ file, userId: 'owner', storage, destination: 'code', operation }),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(remote).toHaveBeenCalledTimes(1);
  expect(claims.size).toBe(0);
  await expect(
    withFileDeletion({ file, userId: 'owner', storage, operation: async () => undefined }),
  ).resolves.toBeUndefined();
});

it('retains a later uncertain request even after an earlier rejected attempt', async () => {
  const { storage, file, claims } = fixture();
  const denied = Object.assign(new Error('throttled'), { response: { status: 429 } });
  await expect(
    withFileProvisioning({
      file,
      userId: 'owner',
      storage,
      destination: 'code',
      operation: async (_claim, onStart) => {
        await dispatchFileStorageOperation(onStart, async () => {
          throw denied;
        }).catch(() => undefined);
        await dispatchFileStorageOperation(onStart, async () => {
          throw new Error('response lost');
        });
        return { value: 'unused', commit: { embedded: true } };
      },
    }),
  ).rejects.toMatchObject({ name: 'FileProvisionOutcomeUnknownError' });
  expect(claims.size).toBe(1);
  expect(storage.releaseFileProvision).not.toHaveBeenCalled();
});

it('does not clear uncertainty after a successful transport response and failed result validation', async () => {
  const { storage, file, claims } = fixture();
  await expect(
    withFileProvisioning({
      file,
      userId: 'owner',
      storage,
      destination: 'code',
      operation: async (_claim, onStart) => {
        await dispatchFileStorageOperation(onStart, async () => ({ status: 200 }));
        throw new Error('malformed upload result');
      },
    }),
  ).rejects.toMatchObject({ name: 'FileProvisionOutcomeUnknownError' });
  expect(claims.size).toBe(1);
});

describe('dispatchFileDeletion', () => {
  it('marks the mutation before dispatch and confirms its result', async () => {
    const onDelete = jest.fn();
    const operation = jest.fn(async () => {
      expect(onDelete.mock.calls).toEqual([[]]);
      return 'deleted';
    });
    await expect(dispatchFileDeletion(onDelete, operation)).resolves.toBe('deleted');
    expect(onDelete.mock.calls).toEqual([[], ['confirmed']]);
  });

  it('reports a definitive mutation rejection', async () => {
    const onDelete = jest.fn();
    const error = Object.assign(new Error('denied'), { $metadata: { httpStatusCode: 403 } });
    await expect(
      dispatchFileDeletion(onDelete, async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(onDelete.mock.calls).toEqual([[], ['rejected']]);
  });

  it('leaves a dispatched mutation uncertain on a lost response', async () => {
    const onDelete = jest.fn();
    const error = Object.assign(new Error('response lost'), { code: 'ETIMEDOUT' });
    await expect(
      dispatchFileDeletion(onDelete, async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(onDelete.mock.calls).toEqual([[]]);
  });

  it('supports callers without an observer', async () => {
    await expect(dispatchFileDeletion(undefined, async () => true)).resolves.toBe(true);
  });
});
