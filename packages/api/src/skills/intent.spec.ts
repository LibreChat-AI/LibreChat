import { FileSources } from 'librechat-data-provider';
import type { SkillUploadIntentDeps, SkillUploadOperation } from './intent';
import { withSkillUploadIntent } from './intent';
import { reserveSkillBlob } from './reservation';

function makeDeps(): jest.Mocked<SkillUploadIntentDeps> {
  return {
    reserveSkillUploadIntent: jest.fn(async (input) => ({ fileId: input.fileId })),
    transitionSkillUploadIntent: jest.fn(async (_fileId, _writerId, _from, _to) => true),
  };
}

function makeOperation(): SkillUploadOperation<string> {
  return {
    skillId: '507f1f77bcf86cd799439011',
    author: '507f1f77bcf86cd799439012',
    fileId: 'file-1',
    source: 'local',
    reservation: {
      source: 'local',
      filepath: '/uploads/owner/file-1',
      writeLocation: { userId: 'owner', fileName: 'file-1', basePath: 'uploads' },
    },
    save: jest.fn(async () => '/uploads/owner/file-1'),
    persist: jest.fn(async () => 'saved'),
    readPersisted: jest.fn(async () => null),
    deleteReserved: jest.fn(async () => undefined),
  };
}

it('persists intent before writing bytes and acknowledges only after row commit', async () => {
  const deps = makeDeps();
  const operation = makeOperation();
  await expect(withSkillUploadIntent(deps, operation)).resolves.toBe('saved');
  expect(deps.reserveSkillUploadIntent.mock.invocationCallOrder[0]).toBeLessThan(
    (operation.save as jest.Mock).mock.invocationCallOrder[0],
  );
  expect(deps.transitionSkillUploadIntent.mock.invocationCallOrder[1]).toBeGreaterThan(
    (operation.persist as jest.Mock).mock.invocationCallOrder[0],
  );
});

it('rejects a provider mismatch before journaling or writing bytes', async () => {
  const deps = makeDeps();
  const operation = makeOperation();
  operation.source = FileSources.s3;
  await expect(withSkillUploadIntent(deps, operation)).rejects.toThrow(
    'Skill upload source differs from its reserved provider',
  );
  expect(deps.reserveSkillUploadIntent).not.toHaveBeenCalled();
  expect(operation.save).not.toHaveBeenCalled();
});

it('persists the canonical provider key instead of a public URL', async () => {
  const deps = makeDeps();
  const operation = makeOperation();
  operation.reservation = {
    source: 's3',
    filepath: 'https://cdn.example.test/uploads/owner/file-1?signature=old',
    storageKey: 'uploads/owner/file-1',
    writeLocation: { userId: 'owner', fileName: 'file-1', basePath: 'uploads' },
  };
  operation.source = FileSources.s3;
  operation.save = jest.fn(
    async () => 'https://cdn.example.test/uploads/owner/file-1?signature=new',
  );
  await withSkillUploadIntent(deps, operation);
  expect(deps.reserveSkillUploadIntent).toHaveBeenCalledWith(
    expect.objectContaining({ storageKey: 'uploads/owner/file-1' }),
  );
});

it('journals the regional object key and compensates a mismatched provider result before persistence', async () => {
  const deps = makeDeps();
  const operation = makeOperation();
  operation.reservation = await reserveSkillBlob({
    source: FileSources.s3,
    userId: 'owner',
    fileName: 'file-1',
    tenantId: 'tenant-a',
    storageRegion: 'us-east-1',
    includeRegionInPath: true,
    getFileURL: async () =>
      'https://cdn.example.test/r/us-east-1/t/tenant-a/uploads/owner/file-1?old=signature',
  });
  operation.source = FileSources.s3;
  operation.save = jest.fn(
    async () =>
      'https://cdn.example.test/r/eu-west-1/t/tenant-a/uploads/owner/file-1?new=signature',
  );
  await expect(withSkillUploadIntent(deps, operation)).rejects.toThrow(
    'Skill storage wrote outside its reserved location',
  );
  expect(deps.reserveSkillUploadIntent).toHaveBeenCalledWith(
    expect.objectContaining({ storageKey: operation.reservation.storageKey }),
  );
  expect(operation.persist).not.toHaveBeenCalled();
  expect(operation.deleteReserved).toHaveBeenCalledWith(
    operation.reservation,
    'https://cdn.example.test/r/eu-west-1/t/tenant-a/uploads/owner/file-1?new=signature',
  );
});

it('retains the actual regional key for stopped-writer cleanup after bytes were written', async () => {
  const deps = makeDeps();
  const operation = makeOperation();
  operation.reservation = await reserveSkillBlob({
    source: FileSources.cloudfront,
    userId: 'owner',
    fileName: 'file-1',
    tenantId: 'tenant-a',
    storageRegion: 'us-east-1',
    includeRegionInPath: true,
    getFileURL: async () => 'https://cdn.example.test/r/us-east-1/t/tenant-a/uploads/owner/file-1',
  });
  operation.source = FileSources.cloudfront;
  operation.save = jest.fn(
    async () =>
      'https://cdn.example.test/r/us-east-1/t/tenant-a/uploads/owner/file-1?signature=refreshed',
  );
  operation.persist = jest.fn(async () => {
    throw new Error('database unavailable');
  });
  operation.deleteReserved = jest.fn(async () => {
    throw new Error('storage unavailable');
  });

  await expect(withSkillUploadIntent(deps, operation)).rejects.toThrow('database unavailable');
  expect(deps.reserveSkillUploadIntent).toHaveBeenCalledWith(
    expect.objectContaining({
      storageKey: 'r/us-east-1/t/tenant-a/uploads/owner/file-1',
    }),
  );
  expect(operation.deleteReserved).toHaveBeenCalledWith(
    operation.reservation,
    expect.stringContaining('/r/us-east-1/t/tenant-a/uploads/owner/file-1'),
  );
  // A stopped writer leaves the pre-written canonical key in the durable intent.
  expect(deps.reserveSkillUploadIntent).toHaveBeenCalledTimes(1);
});

it('keeps an abandoned intent even when immediate compensation succeeds', async () => {
  const deps = makeDeps();
  const operation = makeOperation();
  operation.save = jest.fn(async () => {
    throw new Error('provider timeout');
  });
  await expect(withSkillUploadIntent(deps, operation)).rejects.toThrow('provider timeout');
  expect(deps.transitionSkillUploadIntent).toHaveBeenCalledWith(
    'file-1',
    expect.any(String),
    'uploading',
    'abandoned',
  );
  expect(operation.deleteReserved).toHaveBeenCalled();
});

it.each([null, '', '   '])('compensates a storage write with no usable path (%p)', async (path) => {
  const deps = makeDeps();
  const operation = makeOperation();
  operation.save = jest.fn(async () => path as string);

  await expect(withSkillUploadIntent(deps, operation)).rejects.toThrow(
    'Skill storage returned no saved object path',
  );
  expect(operation.persist).not.toHaveBeenCalled();
  expect(operation.deleteReserved).toHaveBeenCalledWith(operation.reservation, undefined);
});

it.each(['uploading', 'committing'] as const)(
  'compensates the reserved blob even when the %s abandonment update throws',
  async (failedState) => {
    const deps = makeDeps();
    const operation = makeOperation();
    operation.save = jest.fn(async () => {
      throw new Error('provider timeout');
    });
    deps.transitionSkillUploadIntent.mockImplementation(async (_fileId, _writerId, from, to) => {
      if (from === failedState && to === 'abandoned') throw new Error('database unavailable');
      return true;
    });

    await expect(withSkillUploadIntent(deps, operation)).rejects.toThrow('provider timeout');
    expect(deps.transitionSkillUploadIntent).toHaveBeenCalledWith(
      'file-1',
      expect.any(String),
      'uploading',
      'abandoned',
    );
    expect(deps.transitionSkillUploadIntent).toHaveBeenCalledWith(
      'file-1',
      expect.any(String),
      'committing',
      'abandoned',
    );
    expect(operation.deleteReserved).toHaveBeenCalledWith(operation.reservation, undefined);
  },
);

it('preserves the original failure for stopped-writer recovery if journal and cleanup both fail', async () => {
  const deps = makeDeps();
  const operation = makeOperation();
  operation.save = jest.fn(async () => {
    throw new Error('provider timeout');
  });
  deps.transitionSkillUploadIntent.mockRejectedValue(new Error('database unavailable'));
  operation.deleteReserved = jest.fn(async () => {
    throw new Error('storage unavailable');
  });

  await expect(withSkillUploadIntent(deps, operation)).rejects.toThrow('provider timeout');
  expect(deps.reserveSkillUploadIntent).toHaveBeenCalledTimes(1);
  expect(deps.transitionSkillUploadIntent).toHaveBeenCalledTimes(3);
  expect(operation.deleteReserved).toHaveBeenCalledTimes(1);
  // The intent is intentionally retained. If both stores stay unavailable,
  // an operator must recover the stopped writer before background cleanup.
});

it.each(['save', 'first transition'] as const)(
  'compensates a %s failure without reading persistence that was never attempted',
  async (failurePoint) => {
    const deps = makeDeps();
    const operation = makeOperation();
    operation.readPersisted = jest.fn(async () => {
      throw new Error('database unavailable');
    });
    if (failurePoint === 'save') {
      operation.save = jest.fn(async () => {
        throw new Error('provider timeout');
      });
    } else {
      deps.transitionSkillUploadIntent.mockRejectedValueOnce(new Error('database unavailable'));
    }

    await expect(withSkillUploadIntent(deps, operation)).rejects.toThrow(
      failurePoint === 'save' ? 'provider timeout' : 'database unavailable',
    );
    expect(operation.persist).not.toHaveBeenCalled();
    expect(operation.readPersisted).not.toHaveBeenCalled();
    expect(operation.deleteReserved).toHaveBeenCalledTimes(1);
  },
);

it.each(['missing', 'replaced'] as const)(
  'abandons an acknowledged commit after the original row is %s and cleanup fails',
  async (rowState) => {
    const deps = makeDeps();
    const operation = makeOperation();
    let intentState = 'uploading';
    deps.transitionSkillUploadIntent.mockImplementation(async (_fileId, _writerId, from, to) => {
      if (intentState !== from) return intentState === to;
      intentState = to;
      if (from === 'committing' && to === 'committed') {
        throw new Error('commit reply lost');
      }
      return true;
    });
    operation.readPersisted = jest.fn(async () => {
      const row = rowState === 'replaced' ? { fileId: 'replacement' } : null;
      return row?.fileId === operation.fileId ? 'saved' : null;
    });
    operation.deleteReserved = jest.fn(async () => {
      throw new Error('storage unavailable');
    });

    await expect(withSkillUploadIntent(deps, operation)).rejects.toThrow('commit reply lost');
    expect(intentState).toBe('abandoned');
    expect(deps.transitionSkillUploadIntent).toHaveBeenCalledWith(
      operation.fileId,
      expect.any(String),
      'committed',
      'abandoned',
    );
    expect(operation.deleteReserved).toHaveBeenCalledTimes(1);
  },
);

it('returns the persisted row after an ambiguous database commit', async () => {
  const deps = makeDeps();
  const operation = makeOperation();
  operation.persist = jest.fn(async () => {
    throw new Error('lost database reply');
  });
  operation.readPersisted = jest.fn(async () => 'recovered');
  await expect(withSkillUploadIntent(deps, operation)).resolves.toBe('recovered');
  expect(operation.deleteReserved).not.toHaveBeenCalled();
});

it.each(['acknowledgement rejected', 'reply lost'] as const)(
  'returns a persisted upload after recovering %s',
  async (scenario) => {
    const deps = makeDeps();
    const operation = makeOperation();
    operation.readPersisted = jest.fn(async () => 'saved');
    deps.transitionSkillUploadIntent.mockResolvedValueOnce(true);
    if (scenario === 'reply lost') {
      deps.transitionSkillUploadIntent.mockRejectedValueOnce(new Error('lost acknowledgement'));
    } else {
      deps.transitionSkillUploadIntent.mockResolvedValueOnce(false);
    }
    deps.transitionSkillUploadIntent.mockResolvedValueOnce(true);

    await expect(withSkillUploadIntent(deps, operation)).resolves.toBe('saved');
    expect(deps.transitionSkillUploadIntent).toHaveBeenCalledTimes(3);
    expect(operation.deleteReserved).not.toHaveBeenCalled();
  },
);
