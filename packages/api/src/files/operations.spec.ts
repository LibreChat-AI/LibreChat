import type { FileStorageClaim, FileProvisionCommit } from '@librechat/data-schemas';
import type { FileDeleteStorage } from './operations';
import {
  withFileDeletion,
  withFileProvisioning,
  confirmFileProvision,
  createFileProvisionRecovery,
  FileProvisionPersistenceError,
  FileProvisionOutcomeUnknownError,
  isDefinitiveFileStorageFailure,
} from './operations';

const file = { file_id: 'file', user: 'owner', tenantId: 'tenant' };
const scope = { file_id: file.file_id, userId: 'owner', tenantId: file.tenantId };
const result = (value = 'uploaded') => ({
  value,
  commit: { embedded: true, entityId: 'original' },
});
const key = (claim: FileStorageClaim) =>
  JSON.stringify([claim.tenantId ?? null, claim.userId, claim.file_id]);

function storageStatusErrors(status: unknown) {
  return [
    { response: { status } },
    { $metadata: { httpStatusCode: status }, code: 'AccessDenied' },
    { statusCode: status },
    { status },
  ];
}

function setup() {
  const provisioners = new Map<string, string>();
  const deleting = new Map<string, string>();
  const pending = new Set<string>();
  const storage = {
    recovery: createFileProvisionRecovery(),
    commitFileProvision: jest.fn(async (_data: FileProvisionCommit): Promise<boolean> => true),
    acquireFileProvision: jest.fn(async (claim: FileStorageClaim) => {
      if (pending.has(key(claim)) || deleting.has(key(claim))) return false;
      provisioners.set(claim.token, key(claim));
      return true;
    }),
    releaseFileProvision: jest.fn(async (claim: FileStorageClaim): Promise<boolean> => {
      if (provisioners.get(claim.token) === key(claim)) provisioners.delete(claim.token);
      return true;
    }),
    acquireFileDeletion: jest.fn(async (claim: FileStorageClaim) => {
      if (deleting.has(key(claim)) || [...provisioners.values()].includes(key(claim))) return null;
      const resumed = pending.has(key(claim));
      deleting.set(key(claim), claim.token);
      pending.add(key(claim));
      return { resumed };
    }),
    releaseFileDeletion: jest.fn(async (claim: FileStorageClaim & { retainDeletion: boolean }) => {
      if (!deleting.has(key(claim))) return true;
      if (claim.token !== deleting.get(key(claim))) return false;
      deleting.delete(key(claim));
      if (!claim.retainDeletion) pending.delete(key(claim));
      return true;
    }),
  } satisfies FileDeleteStorage;
  return { storage, provisioners, deleting, pending };
}

function provision(
  storage: FileDeleteStorage,
  operation: (
    claim: FileStorageClaim,
    onUploadStart: () => void,
  ) => Promise<ReturnType<typeof result>> = async () => result(),
  destination = 'code:route:sandbox',
  identity = file,
) {
  return withFileProvisioning({
    file: identity,
    userId: 'caller',
    destination,
    storage,
    operation,
  });
}

function barrier() {
  let release: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}

afterEach(() => jest.useRealTimers());

it('blocks provisioning throughout primary I/O and until metadata finalizes', async () => {
  const { storage } = setup();
  const entered = barrier();
  const complete = barrier();
  const deletion = withFileDeletion({
    file,
    userId: 'caller',
    storage,
    operation: async (primaryDeleted) => {
      entered.release();
      await complete.wait;
      primaryDeleted();
    },
  });
  await entered.wait;
  const upload = jest.fn(async () => result());
  await expect(provision(storage, upload)).rejects.toThrow('conflicts');
  complete.release();
  await deletion;
  await expect(provision(storage, upload)).rejects.toThrow('conflicts');
  expect(upload).not.toHaveBeenCalled();
});

it('denies deletion immediately during an active upload without waiting for it', async () => {
  const { storage } = setup();
  const entered = barrier();
  const done = barrier();
  const upload = jest.fn(async () => {
    entered.release();
    await done.wait;
    return result();
  });
  const work = provision(storage, upload);
  await entered.wait;
  const remove = jest.fn();
  await expect(
    withFileDeletion({ file, userId: 'caller', storage, operation: remove }),
  ).rejects.toThrow('conflicts');
  expect(remove).not.toHaveBeenCalled();
  done.release();
  await work;
  await withFileDeletion({ file, userId: 'caller', storage, operation: remove });
  expect(remove).toHaveBeenCalledTimes(1);
});

it('restores repair eligibility after deletion fails before primary removal', async () => {
  const { storage } = setup();
  await expect(
    withFileDeletion({
      file,
      userId: 'caller',
      storage,
      operation: async () => {
        throw new Error('secondary offline');
      },
    }),
  ).rejects.toThrow('secondary offline');
  await expect(provision(storage)).resolves.toBe('uploaded');
});

it('retains deletion intent after a failed retry of an already-removed primary', async () => {
  const { storage } = setup();
  await withFileDeletion({
    file,
    userId: 'caller',
    storage,
    operation: async (removed) => removed(),
  });
  await expect(
    withFileDeletion({
      file,
      userId: 'caller',
      storage,
      operation: async () => {
        throw new Error('metadata offline');
      },
    }),
  ).rejects.toThrow('metadata offline');
  await expect(provision(storage)).rejects.toThrow('conflicts');
});

it('releases the original claim after a failed upload before deletion', async () => {
  const { storage } = setup();
  const upload = jest.fn(async () => {
    throw new Error('upload offline');
  });
  await expect(provision(storage, upload)).rejects.toThrow('upload offline');
  expect(storage.releaseFileProvision).toHaveBeenCalledWith(
    storage.acquireFileProvision.mock.calls[0][0],
  );
  expect(storage.commitFileProvision).not.toHaveBeenCalled();
  await withFileDeletion({ file, userId: 'caller', storage, operation: jest.fn() });
});

it.each([true, false])(
  'reconciles the original acquisition token before a fresh upload when applied=%s',
  async (applied) => {
    const { storage, provisioners } = setup();
    const failure = new Error('private acquisition acknowledgement failure');
    storage.acquireFileProvision.mockImplementationOnce(async (claim) => {
      if (applied) provisioners.set(claim.token, key(claim));
      throw failure;
    });
    const originalUpload = jest.fn(async () => result('stale request'));
    await expect(provision(storage, originalUpload)).rejects.toMatchObject({
      name: 'FileProvisionPersistenceError',
      message: 'File provisioning persistence was not confirmed',
      cause: failure,
    });
    const original = storage.acquireFileProvision.mock.calls[0][0];
    expect(storage.releaseFileProvision).not.toHaveBeenCalled();
    const currentUpload = jest.fn(async (claim: FileStorageClaim) => {
      expect(storage.releaseFileProvision).toHaveBeenLastCalledWith(original);
      expect(provisioners.has(original.token)).toBe(false);
      expect(claim.token).not.toBe(original.token);
      return result('current request');
    });
    await expect(provision({ ...storage }, currentUpload)).resolves.toBe('current request');
    expect(originalUpload).not.toHaveBeenCalled();
    expect(currentUpload).toHaveBeenCalledTimes(1);
    expect(storage.acquireFileProvision).toHaveBeenCalledTimes(2);
    expect(storage.releaseFileProvision.mock.invocationCallOrder[0]).toBeLessThan(
      storage.acquireFileProvision.mock.invocationCallOrder[1],
    );
    expect(provisioners.size).toBe(0);
    await withFileDeletion({ file, userId: 'caller', storage, operation: jest.fn() });
  },
);

it.each([true, false])(
  'releases a settled failed acquisition before deletion when applied=%s',
  async (applied) => {
    const { storage, provisioners } = setup();
    storage.acquireFileProvision.mockImplementationOnce(async (claim) => {
      if (applied) provisioners.set(claim.token, key(claim));
      throw new Error('acknowledgement lost');
    });
    const upload = jest.fn(async () => result());
    await expect(provision(storage, upload)).rejects.toBeInstanceOf(FileProvisionPersistenceError);
    const original = storage.acquireFileProvision.mock.calls[0][0];
    await withFileDeletion({ file, userId: 'caller', storage, operation: jest.fn() });
    expect(storage.releaseFileProvision).toHaveBeenCalledWith(original);
    expect(storage.releaseFileProvision.mock.invocationCallOrder[0]).toBeLessThan(
      storage.acquireFileDeletion.mock.invocationCallOrder[0],
    );
    expect(provisioners.size).toBe(0);
    expect(upload).not.toHaveBeenCalled();
    expect(storage.commitFileProvision).not.toHaveBeenCalled();
  },
);

it('keeps failed acquisition recovery fenced until the original token can be released', async () => {
  const { storage, provisioners } = setup();
  storage.acquireFileProvision.mockImplementationOnce(async (claim) => {
    provisioners.set(claim.token, key(claim));
    throw new Error('acknowledgement lost');
  });
  await expect(provision(storage)).rejects.toBeInstanceOf(FileProvisionPersistenceError);
  const original = storage.acquireFileProvision.mock.calls[0][0];
  storage.releaseFileProvision
    .mockRejectedValueOnce(new Error('database offline'))
    .mockResolvedValueOnce(false);
  const upload = jest.fn(async () => result());
  await expect(provision(storage, upload)).rejects.toBeInstanceOf(FileProvisionPersistenceError);
  await expect(
    withFileDeletion({ file, userId: 'caller', storage, operation: jest.fn() }),
  ).rejects.toBeInstanceOf(FileProvisionPersistenceError);
  expect(storage.acquireFileProvision).toHaveBeenCalledTimes(1);
  expect(storage.acquireFileDeletion).not.toHaveBeenCalled();
  expect(upload).not.toHaveBeenCalled();
  expect(provisioners.has(original.token)).toBe(true);
  await expect(provision(storage, upload)).resolves.toBe('uploaded');
  expect(provisioners.has(original.token)).toBe(false);
});

it('does not wait for or release a pending acquisition during deletion recovery', async () => {
  const { storage, provisioners } = setup();
  const entered = barrier();
  const done = barrier();
  const failure = new Error('acknowledgement lost');
  storage.acquireFileProvision.mockImplementationOnce(async (claim) => {
    provisioners.set(claim.token, key(claim));
    entered.release();
    await done.wait;
    throw failure;
  });
  const upload = jest.fn(async () => result());
  const work = provision(storage, upload);
  const rejected = work.catch((error: unknown) => error);
  await entered.wait;
  await storage.recovery.recover(scope, storage);
  await expect(
    withFileDeletion({ file, userId: 'caller', storage, operation: jest.fn() }),
  ).rejects.toThrow('conflicts');
  expect(storage.releaseFileProvision).not.toHaveBeenCalled();
  expect(upload).not.toHaveBeenCalled();
  done.release();
  expect(await rejected).toMatchObject({ cause: failure });
  await storage.recovery.recover(scope, storage);
  expect(storage.releaseFileProvision).toHaveBeenCalledWith(
    storage.acquireFileProvision.mock.calls[0][0],
  );
  expect(provisioners.size).toBe(0);
});

it('retains a synchronous acquisition failure without reentrant recovery releasing it', async () => {
  const { storage } = setup();
  const failure = new Error('synchronous acquisition failure');
  let recovery: Promise<void> | undefined;
  storage.acquireFileProvision.mockImplementationOnce(() => {
    recovery = storage.recovery.recover(scope, storage);
    throw failure;
  });
  await expect(provision(storage)).rejects.toMatchObject({ cause: failure });
  await recovery;
  expect(storage.releaseFileProvision).not.toHaveBeenCalled();
  await expect(provision(storage)).resolves.toBe('uploaded');
  expect(storage.acquireFileProvision).toHaveBeenCalledTimes(2);
});

it('assigns the recovery attempt before a release can reenter recovery', async () => {
  const { storage, provisioners } = setup();
  storage.acquireFileProvision.mockRejectedValueOnce(new Error('acknowledgement lost'));
  await expect(provision(storage)).rejects.toBeInstanceOf(FileProvisionPersistenceError);
  let reentrant: Promise<void> | undefined;
  storage.releaseFileProvision.mockImplementationOnce(async (claim) => {
    reentrant = storage.recovery.recover(scope, storage);
    provisioners.delete(claim.token);
    return true;
  });
  await storage.recovery.recover(scope, storage);
  await reentrant;
  expect(storage.releaseFileProvision).toHaveBeenCalledTimes(1);
  expect(storage.commitFileProvision).not.toHaveBeenCalled();
});

it('discards an explicitly contended acquisition without attempting to release it', async () => {
  const { storage } = setup();
  storage.acquireFileProvision.mockResolvedValueOnce(false);
  await expect(provision(storage)).rejects.toThrow('conflicts');
  expect(storage.releaseFileProvision).not.toHaveBeenCalled();
  await expect(provision(storage)).resolves.toBe('uploaded');
});

it('reuses one active upload for overlapping same-destination calls', async () => {
  const { storage } = setup();
  const entered = barrier();
  const done = barrier();
  const upload = jest.fn(async () => {
    entered.release();
    await done.wait;
    return result();
  });
  const first = provision(storage, upload);
  await entered.wait;
  const secondUpload = jest.fn(async () => result('wrong'));
  const second = provision(storage, secondUpload);
  done.release();
  await expect(Promise.all([first, second])).resolves.toEqual(['uploaded', 'uploaded']);
  expect(upload).toHaveBeenCalledTimes(1);
  expect(secondUpload).not.toHaveBeenCalled();
  expect(storage.commitFileProvision).toHaveBeenCalledTimes(1);
});

it('recovers two failed commit attempts with the original token and no new upload', async () => {
  const { storage, provisioners } = setup();
  storage.commitFileProvision
    .mockResolvedValueOnce(false)
    .mockRejectedValueOnce(new Error('database'));
  const uploaded = result();
  const upload = jest.fn(async () => uploaded);
  await expect(provision(storage, upload)).rejects.toBeInstanceOf(FileProvisionPersistenceError);
  expect(storage.commitFileProvision).toHaveBeenCalledTimes(2);
  expect(storage.releaseFileProvision).not.toHaveBeenCalled();
  expect(provisioners.size).toBe(1);
  uploaded.commit.entityId = 'mutated';
  const freshCallback = jest.fn(async () => result('wrong'));
  await expect(provision({ ...storage }, freshCallback)).resolves.toBe('uploaded');
  expect(upload).toHaveBeenCalledTimes(1);
  expect(freshCallback).not.toHaveBeenCalled();
  expect(storage.acquireFileProvision).toHaveBeenCalledTimes(1);
  const original = storage.acquireFileProvision.mock.calls[0][0];
  for (const [commit] of storage.commitFileProvision.mock.calls) {
    expect(commit.claim).toEqual(original);
    expect(commit.entityId).toBe('original');
  }
  expect(storage.releaseFileProvision).toHaveBeenCalledWith(original);
  expect(provisioners.size).toBe(0);
});

it('serializes two overlapping recovery calls into one commit', async () => {
  const { storage } = setup();
  storage.commitFileProvision.mockResolvedValueOnce(false).mockResolvedValueOnce(false);
  await expect(provision(storage)).rejects.toBeInstanceOf(FileProvisionPersistenceError);
  const entered = barrier();
  const done = barrier();
  storage.commitFileProvision.mockImplementationOnce(async () => {
    entered.release();
    await done.wait;
    return true;
  });
  const first = storage.recovery.recover(scope, storage);
  await entered.wait;
  const second = storage.recovery.recover(scope, storage);
  done.release();
  await Promise.all([first, second]);
  expect(storage.commitFileProvision).toHaveBeenCalledTimes(3);
  expect(storage.releaseFileProvision).toHaveBeenCalledTimes(1);
});

it('retries only release after a confirmed commit without overwriting its result', async () => {
  const { storage } = setup();
  storage.releaseFileProvision.mockResolvedValueOnce(false);
  const upload = jest.fn(async () => result());
  await expect(provision(storage, upload)).rejects.toBeInstanceOf(FileProvisionPersistenceError);
  const replacement = jest.fn(async () => result('wrong'));
  await expect(provision(storage, replacement)).resolves.toBe('uploaded');
  expect(replacement).not.toHaveBeenCalled();
  expect(storage.commitFileProvision).toHaveBeenCalledTimes(1);
  expect(storage.releaseFileProvision).toHaveBeenCalledTimes(2);
  expect(storage.releaseFileProvision.mock.calls[0][0]).toEqual(
    storage.releaseFileProvision.mock.calls[1][0],
  );
});

it('finishes release-only upload failure recovery before acquiring a new token', async () => {
  const { storage } = setup();
  storage.releaseFileProvision.mockRejectedValueOnce(new Error('release offline'));
  const failure = new Error('original upload failure');
  await expect(
    provision(
      storage,
      jest.fn(async () => {
        throw failure;
      }),
    ),
  ).rejects.toBe(failure);
  const original = storage.acquireFileProvision.mock.calls[0][0];
  const upload = jest.fn(async () => {
    expect(storage.releaseFileProvision).toHaveBeenLastCalledWith(original);
    return result('new upload');
  });
  await expect(provision(storage, upload)).resolves.toBe('new upload');
  expect(storage.acquireFileProvision).toHaveBeenCalledTimes(2);
  expect(storage.acquireFileProvision.mock.calls[1][0].token).not.toBe(original.token);
  expect(storage.commitFileProvision).toHaveBeenCalledTimes(1);
});

it('keeps release-only recovery when releasing a failed upload still fails', async () => {
  const { storage } = setup();
  storage.releaseFileProvision.mockResolvedValue(false);
  await expect(
    provision(
      storage,
      jest.fn(async () => {
        throw new Error('upload');
      }),
    ),
  ).rejects.toThrow('upload');
  const next = jest.fn(async () => result());
  await expect(provision(storage, next)).rejects.toBeInstanceOf(FileProvisionPersistenceError);
  expect(next).not.toHaveBeenCalled();
  expect(storage.acquireFileProvision).toHaveBeenCalledTimes(1);
  storage.releaseFileProvision.mockResolvedValue(true);
  await expect(provision(storage, next)).resolves.toBe('uploaded');
});

it('recovers a completed upload before acquiring deletion', async () => {
  const { storage, provisioners } = setup();
  storage.commitFileProvision.mockResolvedValueOnce(false).mockResolvedValueOnce(false);
  await expect(provision(storage)).rejects.toBeInstanceOf(FileProvisionPersistenceError);
  const remove = jest.fn(async () => {
    expect(provisioners.size).toBe(0);
    expect(storage.commitFileProvision).toHaveBeenCalledTimes(3);
  });
  await withFileDeletion({ file, userId: 'caller', storage, operation: remove });
  expect(remove).toHaveBeenCalledTimes(1);
});

it('does not acquire deletion when known recovery still fails', async () => {
  const { storage } = setup();
  storage.commitFileProvision.mockResolvedValue(false);
  await expect(provision(storage)).rejects.toBeInstanceOf(FileProvisionPersistenceError);
  await expect(
    withFileDeletion({ file, userId: 'caller', storage, operation: jest.fn() }),
  ).rejects.toBeInstanceOf(FileProvisionPersistenceError);
  expect(storage.acquireFileDeletion).not.toHaveBeenCalled();
  expect(storage.releaseFileProvision).not.toHaveBeenCalled();
});

it.each([
  { ...file, file_id: 'other-file' },
  { ...file, user: 'other-owner' },
  { ...file, tenantId: 'other-tenant' },
])('isolates failed recovery from scope %j', async (other) => {
  const { storage } = setup();
  storage.commitFileProvision.mockResolvedValueOnce(false).mockResolvedValueOnce(false);
  await expect(provision(storage)).rejects.toBeInstanceOf(FileProvisionPersistenceError);
  const otherUpload = jest.fn(async () => result('other'));
  await expect(provision(storage, otherUpload, 'code:route:sandbox', other)).resolves.toBe('other');
  expect(otherUpload).toHaveBeenCalledTimes(1);
  await storage.recovery.recover(scope, storage);
});

it('keeps destinations independent while deletion waits for every claim', async () => {
  const { storage, provisioners } = setup();
  const entered = barrier();
  const done = barrier();
  let started = 0;
  const upload = jest.fn(async () => {
    if (++started === 2) entered.release();
    await done.wait;
    return result();
  });
  const uploads = [provision(storage, upload, 'route:a'), provision(storage, upload, 'route:b')];
  await entered.wait;
  expect(provisioners.size).toBe(2);
  await expect(
    withFileDeletion({ file, userId: 'caller', storage, operation: jest.fn() }),
  ).rejects.toThrow('conflicts');
  done.release();
  await Promise.all(uploads);
  expect(provisioners.size).toBe(0);
});

it('never releases an unknown foreign claim', async () => {
  const { storage, provisioners } = setup();
  const foreign = { ...scope, token: 'foreign-worker' };
  await storage.acquireFileProvision(foreign);
  await storage.recovery.recover(scope, storage);
  await expect(
    withFileDeletion({ file, userId: 'caller', storage, operation: jest.fn() }),
  ).rejects.toThrow('conflicts');
  expect(storage.releaseFileProvision).not.toHaveBeenCalled();
  expect(provisioners.has(foreign.token)).toBe(true);
});

it('does not expire a known remote result', async () => {
  const { storage } = setup();
  storage.commitFileProvision.mockResolvedValueOnce(false).mockResolvedValueOnce(false);
  const upload = jest.fn(async () => result());
  await expect(provision(storage, upload)).rejects.toBeInstanceOf(FileProvisionPersistenceError);
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2099-01-01'));
  await expect(provision(storage, upload)).resolves.toBe('uploaded');
  expect(upload).toHaveBeenCalledTimes(1);
});

it('removes successful entries so a later independent call uploads again', async () => {
  const { storage } = setup();
  const upload = jest.fn(async () => result());
  await provision(storage, upload);
  await provision(storage, upload);
  expect(upload).toHaveBeenCalledTimes(2);
  expect(storage.acquireFileProvision).toHaveBeenCalledTimes(2);
});

it('preserves generic value references during recovery', async () => {
  const { storage } = setup();
  storage.commitFileProvision.mockResolvedValueOnce(false).mockResolvedValueOnce(false);
  const value = { remote: 'ref' };
  const options = {
    file,
    userId: 'caller',
    destination: 'vector:namespace',
    storage,
    operation: jest.fn(async () => ({ value, commit: { embedded: true } })),
  };
  await expect(withFileProvisioning(options)).rejects.toBeInstanceOf(FileProvisionPersistenceError);
  await expect(withFileProvisioning(options)).resolves.toBe(value);
  expect(options.operation).toHaveBeenCalledTimes(1);
});

it('retains the standalone safe persistence error contract', async () => {
  const { storage } = setup();
  storage.commitFileProvision.mockRejectedValue(new Error('private database detail'));
  await expect(
    confirmFileProvision(storage, { claim: { ...scope, token: 'token' } }),
  ).rejects.toThrow('File provisioning persistence was not confirmed');
});

it('releases a preflight failure that never started the upload', async () => {
  const { storage, provisioners } = setup();
  const error = new Error('storage read failed');
  const upload = jest.fn(async (_claim: FileStorageClaim, _start: () => void) => {
    throw error;
  });
  await expect(provision(storage, upload)).rejects.toBe(error);
  expect(provisioners.size).toBe(0);
  expect(storage.releaseFileProvision).toHaveBeenCalledWith(
    storage.acquireFileProvision.mock.calls[0][0],
  );
  await expect(provision(storage)).resolves.toBe('uploaded');
});

it.each([
  Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }),
  Object.assign(new Error('aborted'), { name: 'AbortError' }),
  new Error('lost response'),
  ...[408, 409, 500, 503].flatMap(storageStatusErrors),
])('retains an ambiguous started upload without retrying or releasing: %j', async (error) => {
  const { storage, provisioners } = setup();
  const upload = jest.fn(async (_claim: FileStorageClaim, start: () => void) => {
    start();
    throw error;
  });
  await expect(provision(storage, upload)).rejects.toBeInstanceOf(FileProvisionOutcomeUnknownError);
  expect(provisioners.size).toBe(1);
  const replacement = jest.fn(async () => result('wrong'));
  await expect(provision(storage, replacement)).rejects.toBeInstanceOf(
    FileProvisionOutcomeUnknownError,
  );
  await expect(storage.recovery.recover(scope, storage)).rejects.toBeInstanceOf(
    FileProvisionOutcomeUnknownError,
  );
  const remove = jest.fn();
  await expect(
    withFileDeletion({ file, userId: 'caller', storage, operation: remove }),
  ).rejects.toBeInstanceOf(FileProvisionOutcomeUnknownError);
  expect(remove).not.toHaveBeenCalled();
  expect(replacement).not.toHaveBeenCalled();
  expect(upload).toHaveBeenCalledTimes(1);
  expect(storage.acquireFileProvision).toHaveBeenCalledTimes(1);
  expect(storage.commitFileProvision).not.toHaveBeenCalled();
  expect(storage.releaseFileProvision).not.toHaveBeenCalled();
  expect(storage.acquireFileDeletion).not.toHaveBeenCalled();
});

it.each([403, 429].flatMap(storageStatusErrors))(
  'releases a definitive SDK upload rejection and permits a fresh upload: %j',
  async (error) => {
    const { storage, provisioners } = setup();
    const upload = jest.fn(async (_claim: FileStorageClaim, start: () => void) => {
      start();
      throw error;
    });
    await expect(provision(storage, upload)).rejects.toBe(error);
    expect(provisioners.size).toBe(0);
    expect(storage.releaseFileProvision).toHaveBeenCalledTimes(1);
    const fresh = jest.fn(async () => result('fresh'));
    await expect(provision(storage, fresh)).resolves.toBe('fresh');
    expect(fresh).toHaveBeenCalledTimes(1);
    expect(storage.acquireFileProvision).toHaveBeenCalledTimes(2);
  },
);

it.each([
  new Error('lost deletion response'),
  Object.assign(new Error('aborted'), { name: 'AbortError' }),
  ...[408, 409, 500, 503].flatMap(storageStatusErrors),
])('retains deletion intent after ambiguous primary dispatch: %j', async (error) => {
  const { storage } = setup();
  await expect(
    withFileDeletion({
      file,
      userId: 'caller',
      storage,
      operation: async (primaryDeleted) => {
        primaryDeleted(false);
        throw error;
      },
    }),
  ).rejects.toBe(error);
  expect(storage.releaseFileDeletion).toHaveBeenLastCalledWith(
    expect.objectContaining({ retainDeletion: true }),
  );
  await expect(provision(storage)).rejects.toThrow('conflicts');
});

it.each([...storageStatusErrors(403), Object.assign(new Error('denied'), { code: 'EACCES' })])(
  'clears newly acquired deletion intent after a definitive primary rejection: %j',
  async (error) => {
    const { storage } = setup();
    await expect(
      withFileDeletion({
        file,
        userId: 'caller',
        storage,
        operation: async (primaryDeleted) => {
          primaryDeleted(false);
          throw error;
        },
      }),
    ).rejects.toBe(error);
    expect(storage.releaseFileDeletion).toHaveBeenLastCalledWith(
      expect.objectContaining({ retainDeletion: false }),
    );
    await expect(provision(storage)).resolves.toBe('uploaded');
  },
);

it.each(storageStatusErrors(403))(
  'never clears resumed deletion intent on an SDK rejection: %j',
  async (error) => {
    const { storage } = setup();
    await withFileDeletion({
      file,
      userId: 'caller',
      storage,
      operation: async (primaryDeleted) => primaryDeleted(),
    });
    await expect(
      withFileDeletion({
        file,
        userId: 'caller',
        storage,
        operation: async (primaryDeleted) => {
          primaryDeleted(false);
          throw error;
        },
      }),
    ).rejects.toBe(error);
    expect(storage.releaseFileDeletion).toHaveBeenLastCalledWith(
      expect.objectContaining({ retainDeletion: true }),
    );
    await expect(provision(storage)).rejects.toThrow('conflicts');
  },
);

it.each([400, 401, 403, 404, 413, 415, 422, 429].flatMap(storageStatusErrors))(
  'classifies explicit numeric SDK HTTP denial as definitive: %j',
  (error) => {
    expect(isDefinitiveFileStorageFailure(error)).toBe(true);
  },
);

it.each(['EACCES', 'EPERM', 'CODE_API_RATE_LIMITED'])(
  'classifies safe pre-dispatch code %s as definitive',
  (code) => {
    expect(isDefinitiveFileStorageFailure({ code })).toBe(true);
  },
);

it.each([
  undefined,
  null,
  '403',
  ...storageStatusErrors('403'),
  ...storageStatusErrors(undefined),
  ...storageStatusErrors(null),
  { response: { status: 408 } },
  { response: { status: 409 } },
  { response: { status: 502 } },
  { code: 'ECONNRESET' },
  { name: 'AbortError' },
])('does not infer definitive rejection from %j', (error) => {
  expect(isDefinitiveFileStorageFailure(error)).toBe(false);
});

it.each([1, 2])('classifies a RAG HTTP denial through %s wrapped causes', async (depth) => {
  const { storage } = setup();
  let error: unknown = { response: { status: 403 } };
  for (let index = 0; index < depth; index++)
    error = new Error('RAG operation failed', { cause: error });
  expect(isDefinitiveFileStorageFailure(error)).toBe(true);
  const upload = jest.fn(async (_claim: FileStorageClaim, start: () => void) => {
    start();
    throw error;
  });
  await expect(provision(storage, upload)).rejects.toBe(error);
  expect(storage.releaseFileProvision).toHaveBeenCalledTimes(1);
  await expect(provision(storage)).resolves.toBe('uploaded');
});

it('retains an ambiguous wrapped RAG network failure', async () => {
  const { storage } = setup();
  const error = new Error('RAG operation failed', {
    cause: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }),
  });
  expect(isDefinitiveFileStorageFailure(error)).toBe(false);
  const upload = jest.fn(async (_claim: FileStorageClaim, start: () => void) => {
    start();
    throw error;
  });
  await expect(provision(storage, upload)).rejects.toBeInstanceOf(FileProvisionOutcomeUnknownError);
  expect(storage.releaseFileProvision).not.toHaveBeenCalled();
});

it('bounds cause traversal and does not override an explicit ambiguous response', () => {
  let error: unknown = { response: { status: 403 } };
  for (let index = 0; index < 3; index++) error = new Error('wrapped', { cause: error });
  expect(isDefinitiveFileStorageFailure(error)).toBe(false);
  const cyclic: { cause?: unknown } = {};
  cyclic.cause = cyclic;
  expect(isDefinitiveFileStorageFailure(cyclic)).toBe(false);
  expect(
    isDefinitiveFileStorageFailure({
      response: { status: 500 },
      cause: { response: { status: 403 } },
    }),
  ).toBe(false);
});

it.each(storageStatusErrors(403))(
  'keeps confirmed primary removal fenced after an SDK denial: %j',
  async (error) => {
    const { storage } = setup();
    await expect(
      withFileDeletion({
        file,
        userId: 'caller',
        storage,
        operation: async (primaryDeleted) => {
          primaryDeleted(true);
          throw new Error('reconciliation failed', {
            cause: error,
          });
        },
      }),
    ).rejects.toThrow('reconciliation failed');
    expect(storage.releaseFileDeletion).toHaveBeenCalledWith(
      expect.objectContaining({ retainDeletion: true }),
    );
  },
);

it('retains any unknown secondary outcome even when another copy reports a definitive denial', async () => {
  const { storage } = setup();
  await expect(
    withFileDeletion({
      file,
      userId: 'caller',
      storage,
      operation: async (_primary, onOutcomeUnknown) => {
        onOutcomeUnknown();
        throw Object.assign(new Error('other copy denied'), { response: { status: 403 } });
      },
    }),
  ).rejects.toThrow('other copy denied');
  expect(storage.releaseFileDeletion).toHaveBeenCalledWith(
    expect.objectContaining({ retainDeletion: true }),
  );
});

it.each([408, 409, 500, 503, '403', undefined].flatMap(storageStatusErrors))(
  'does not let a safe code or deeper denial override an explicit unknown SDK status: %j',
  (error) => {
    expect(
      isDefinitiveFileStorageFailure({
        ...error,
        code: 'EACCES',
        cause: { response: { status: 403 } },
      }),
    ).toBe(false);
  },
);

it.each([
  { response: { status: 500 }, $metadata: { httpStatusCode: 403 }, statusCode: 403, status: 403 },
  { $metadata: { httpStatusCode: 500 }, statusCode: 403, status: 403 },
  { statusCode: 500, status: 403 },
])('prioritizes SDK HTTP contracts in adapter order: %j', (error) => {
  expect(isDefinitiveFileStorageFailure(error)).toBe(false);
});

describe('deletion token recovery', () => {
  it.each([true, false])(
    'reconciles a lost acquisition acknowledgement when applied=%s',
    async (applied) => {
      const { storage } = setup();
      const acquire = storage.acquireFileDeletion.getMockImplementation()!;
      const failure = new Error('acquisition acknowledgement lost');
      storage.acquireFileDeletion.mockImplementationOnce(async (claim) => {
        if (applied) await acquire(claim);
        throw failure;
      });
      const stale = jest.fn();
      await expect(
        withFileDeletion({ file, userId: 'caller', storage, operation: stale }),
      ).rejects.toBe(failure);
      const original = storage.acquireFileDeletion.mock.calls[0][0];
      expect(storage.releaseFileDeletion).not.toHaveBeenCalled();
      const current = jest.fn(async (removed: () => void) => {
        removed();
        return 'current';
      });
      await expect(
        withFileDeletion({ file, userId: 'caller', storage: { ...storage }, operation: current }),
      ).resolves.toBe('current');
      expect(stale).not.toHaveBeenCalled();
      expect(current).toHaveBeenCalledTimes(1);
      expect(storage.releaseFileDeletion.mock.calls[0][0]).toEqual({
        ...original,
        retainDeletion: true,
      });
      expect(storage.acquireFileDeletion.mock.calls[1][0].token).not.toBe(original.token);
      expect(storage.releaseFileDeletion.mock.invocationCallOrder[0]).toBeLessThan(
        storage.acquireFileDeletion.mock.invocationCallOrder[1],
      );
    },
  );

  it.each(['throw', 'false', 'lost-ack'] as const)(
    'recovers %s release after success without repeating primary I/O',
    async (failure) => {
      const { storage } = setup();
      const release = storage.releaseFileDeletion.getMockImplementation()!;
      storage.releaseFileDeletion.mockImplementationOnce(async (claim) => {
        if (failure === 'lost-ack') await release(claim);
        if (failure === 'false') return false;
        throw new Error('release unavailable');
      });
      const value = { primary: 'removed' };
      const operation = jest.fn(async (removed: () => void) => {
        removed();
        return value;
      });
      const options = { file, userId: 'caller', storage, operation };
      await expect(withFileDeletion(options)).rejects.toThrow();
      const replacement = jest.fn(async () => ({ primary: 'wrong' }));
      await expect(withFileDeletion({ ...options, operation: replacement })).resolves.toBe(value);
      expect(operation).toHaveBeenCalledTimes(1);
      expect(replacement).not.toHaveBeenCalled();
      expect(storage.acquireFileDeletion).toHaveBeenCalledTimes(1);
      expect(storage.releaseFileDeletion.mock.calls[1][0]).toEqual(
        storage.releaseFileDeletion.mock.calls[0][0],
      );
      await expect(provision(storage)).rejects.toThrow('conflicts');
    },
  );

  it.each([false, true])(
    'preserves operation failure while release recovery is pending, progress=%s',
    async (progress) => {
      const { storage } = setup();
      storage.releaseFileDeletion.mockResolvedValueOnce(false).mockResolvedValueOnce(false);
      const failure = new Error('original failure');
      const operation = jest.fn(async (removed: () => void) => {
        if (progress) removed();
        throw failure;
      });
      const options = { file, userId: 'caller', storage, operation };
      await expect(withFileDeletion(options)).rejects.toBe(failure);
      const original = storage.acquireFileDeletion.mock.calls[0][0];
      const upload = jest.fn(async () => result());
      await expect(provision(storage, upload)).rejects.toThrow('conflicts');
      const current = jest.fn(async () => 'current');
      await expect(withFileDeletion({ ...options, operation: current })).rejects.toThrow(
        'could not be released',
      );
      expect(current).not.toHaveBeenCalled();
      expect(storage.acquireFileDeletion).toHaveBeenCalledTimes(1);
      await expect(withFileDeletion({ ...options, operation: current })).resolves.toBe('current');
      expect(storage.releaseFileDeletion.mock.calls[2][0]).toEqual({
        ...original,
        retainDeletion: progress,
      });
      expect(operation).toHaveBeenCalledTimes(1);
      expect(current).toHaveBeenCalledTimes(1);
      expect(upload).not.toHaveBeenCalled();
      if (progress) await expect(provision(storage)).rejects.toThrow('conflicts');
      else await expect(provision(storage)).resolves.toBe('uploaded');
    },
  );

  it('does not reopen provisioning after a preflight release applied but lost its acknowledgement', async () => {
    const { storage } = setup();
    const release = storage.releaseFileDeletion.getMockImplementation()!;
    storage.releaseFileDeletion.mockImplementationOnce(async (claim) => {
      await release(claim);
      throw new Error('release acknowledgement lost');
    });
    await expect(
      withFileDeletion({
        file,
        userId: 'caller',
        storage,
        operation: async () => {
          throw new Error('preflight');
        },
      }),
    ).rejects.toThrow('preflight');
    const upload = jest.fn(async () => result());
    await expect(provision(storage, upload)).rejects.toThrow('conflicts');
    expect(upload).not.toHaveBeenCalled();
    await withFileDeletion({ file, userId: 'caller', storage, operation: async () => undefined });
    await expect(provision(storage)).resolves.toBe('uploaded');
  });

  it.each(['acquire', 'operation', 'release'] as const)(
    'rejects overlap immediately during %s',
    async (phase) => {
      const { storage } = setup();
      const entered = barrier();
      const done = barrier();
      const pause = async () => {
        entered.release();
        await done.wait;
      };
      if (phase === 'acquire') {
        const acquire = storage.acquireFileDeletion.getMockImplementation()!;
        storage.acquireFileDeletion.mockImplementationOnce(async (claim) => {
          await pause();
          return acquire(claim);
        });
      }
      if (phase === 'release') {
        const release = storage.releaseFileDeletion.getMockImplementation()!;
        storage.releaseFileDeletion.mockImplementationOnce(async (claim) => {
          await pause();
          return release(claim);
        });
      }
      const first = withFileDeletion({
        file,
        userId: 'caller',
        storage,
        operation: async () => {
          if (phase === 'operation') await pause();
        },
      });
      await entered.wait;
      const replacement = jest.fn();
      await expect(
        withFileDeletion({ file, userId: 'caller', storage, operation: replacement }),
      ).rejects.toThrow('conflicts');
      expect(replacement).not.toHaveBeenCalled();
      expect(storage.acquireFileDeletion).toHaveBeenCalledTimes(1);
      done.release();
      await first;
    },
  );

  it('registers the claim before a synchronous adapter reenters deletion', async () => {
    const { storage } = setup();
    let reentrant: Promise<unknown> | undefined;
    storage.acquireFileDeletion.mockImplementationOnce(() => {
      reentrant = withFileDeletion({ file, userId: 'caller', storage, operation: jest.fn() }).catch(
        (error: unknown) => error,
      );
      throw new Error('synchronous acquisition failure');
    });
    await expect(
      withFileDeletion({ file, userId: 'caller', storage, operation: jest.fn() }),
    ).rejects.toThrow('synchronous acquisition failure');
    expect(await reentrant).toMatchObject({ message: expect.stringContaining('conflicts') });
    expect(storage.acquireFileDeletion).toHaveBeenCalledTimes(1);
    expect(storage.releaseFileDeletion).not.toHaveBeenCalled();
  });

  it.each([
    { ...file, file_id: 'other-file' },
    { ...file, user: 'other-owner' },
    { ...file, tenantId: 'other-tenant' },
  ])('isolates deletion recovery from %j', async (other) => {
    const { storage } = setup();
    storage.releaseFileDeletion.mockResolvedValueOnce(false);
    const value = {};
    await expect(
      withFileDeletion({ file, userId: 'caller', storage, operation: async () => value }),
    ).rejects.toThrow();
    await expect(
      withFileDeletion({ file: other, userId: 'caller', storage, operation: async () => 'other' }),
    ).resolves.toBe('other');
    await expect(
      withFileDeletion({ file, userId: 'caller', storage, operation: jest.fn() }),
    ).resolves.toBe(value);
  });

  it('never releases or steals a foreign deletion token, including after restart', async () => {
    const { storage, deleting } = setup();
    deleting.set(key({ ...scope, token: 'foreign' }), 'foreign');
    const operation = jest.fn();
    for (const recovery of [storage.recovery, createFileProvisionRecovery()]) {
      await expect(
        withFileDeletion({ file, userId: 'caller', storage: { ...storage, recovery }, operation }),
      ).rejects.toThrow('conflicts');
    }
    expect(storage.releaseFileDeletion).not.toHaveBeenCalled();
    expect(operation).not.toHaveBeenCalled();
    expect([...deleting.values()]).toEqual(['foreign']);
  });
});
