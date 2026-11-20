import { createServer } from 'node:http';
import axios, { AxiosError } from 'axios';
import type { FileStorageClaim } from '@librechat/data-schemas';
import type { AddressInfo } from 'node:net';
import type { FileStorageUploadObserver } from './operations';
import {
  dispatchCodeApiUpload,
  dispatchFileDeletion,
  dispatchFileStorageOperation,
  isUndispatchedRequestError,
} from './dispatch';
import {
  createCodeApiRateLimitBudget,
  createCodeApiUploadRegistry,
  withCodeApiUploadRecovery,
} from '../utils/code';
import { createFileProvisionRecovery, withFileDeletion, withFileProvisioning } from './operations';

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

describe('Code API upload dispatch', () => {
  async function refusedConnection(): Promise<unknown> {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const { port } = closed.address() as AddressInfo;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    return axios.post(`http://127.0.0.1:${port}/v1/upload`, 'body', { proxy: false }).then(
      () => undefined,
      (error: unknown) => error,
    );
  }
  const connectFailure = (code: string) =>
    Object.assign(new Error(`connect ${code}`), { code, syscall: 'connect' });

  it('recognizes a request that never reached the server', async () => {
    const refused = await refusedConnection();
    expect(refused).toMatchObject({ code: 'ECONNREFUSED' });
    expect(isUndispatchedRequestError(refused)).toBe(true);
    expect(isUndispatchedRequestError(new Error('upload failed', { cause: refused }))).toBe(true);
    expect(
      isUndispatchedRequestError(
        AxiosError.from(
          new AggregateError([connectFailure('ETIMEDOUT'), connectFailure('ENETUNREACH')]),
        ),
      ),
    ).toBe(true);
    expect(
      isUndispatchedRequestError(
        Object.assign(new Error('getaddrinfo ENOTFOUND'), { syscall: 'getaddrinfo' }),
      ),
    ).toBe(true);
  });

  it.each([
    ['a reset after the request was written', { code: 'ECONNRESET', syscall: 'read' }],
    ['a broken pipe while sending', { code: 'EPIPE', syscall: 'write' }],
    ['a response timeout', { code: 'ECONNABORTED' }],
    ['an answered request', { response: { status: 500 }, cause: connectFailure('ETIMEDOUT') }],
    [
      'address attempts that did not all fail to connect',
      { errors: [connectFailure('ETIMEDOUT'), { code: 'ECONNRESET', syscall: 'read' }] },
    ],
  ])('leaves %s unknown', (_label, shape) => {
    expect(isUndispatchedRequestError(Object.assign(new Error('failed'), shape))).toBe(false);
  });

  it('releases every claim of a request the Code API never received', async () => {
    const refused = await refusedConnection();
    const files = [fixture(), fixture()];
    const observers: FileStorageUploadObserver[] = [];
    let resolveJoined!: () => void;
    const joined = new Promise<void>((resolve) => {
      resolveJoined = resolve;
    });
    const request = joined.then(() =>
      dispatchCodeApiUpload(observers, async () => {
        throw refused;
      }),
    );
    const results = await Promise.allSettled(
      files.map(({ storage, file }, index) =>
        withFileProvisioning({
          file: { ...file, file_id: `file-${index}` },
          userId: 'owner',
          storage,
          destination: 'code',
          operation: async (_claim, onUploadStart) => {
            observers.push(onUploadStart);
            if (observers.length === files.length) resolveJoined();
            await request;
            return { value: 'uploaded', commit: { embedded: true } };
          },
        }),
      ),
    );
    for (const result of results) {
      expect(result).toMatchObject({ status: 'rejected', reason: refused });
    }
    for (const { claims, storage } of files) {
      expect(claims.size).toBe(0);
      expect(storage.releaseFileProvision).toHaveBeenCalledTimes(1);
    }
  });

  it('keeps the claims of a request whose answer was lost', async () => {
    const { storage, file, claims } = fixture();
    const lost = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    await expect(
      withFileProvisioning({
        file,
        userId: 'owner',
        storage,
        destination: 'code',
        operation: async (_claim, onUploadStart) => {
          await dispatchCodeApiUpload([onUploadStart], async () => {
            throw lost;
          });
          return { value: 'uploaded', commit: { embedded: true } };
        },
      }),
    ).rejects.toMatchObject({ name: 'FileProvisionOutcomeUnknownError' });
    expect(claims.size).toBe(1);
  });
});
