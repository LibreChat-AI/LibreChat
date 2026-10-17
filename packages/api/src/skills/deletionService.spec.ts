import type { AppConfig, SkillUploadIntentRecord } from '@librechat/data-schemas';
import { createSkillDeletionService } from './deletionService';

it('records failed cleanup attempts before releasing the claim', async () => {
  const skillId = '507f1f77bcf86cd799439011';
  const journal = { skillId };
  const order: string[] = [];
  let released: () => void = () => undefined;
  const releaseObserved = new Promise<void>((resolve) => {
    released = resolve;
  });
  const persistence = {
    discoverUnjournaledDeletions: jest.fn(async () => 0),
    listSkillDeletionTombstones: jest.fn(async () => [journal]),
    claimSkillDeletion: jest.fn(async () => true),
    refreshSkillDeletionClaim: jest.fn(async () => true),
    noteSkillDeletionAttempt: jest.fn(async () => {
      order.push('attempt');
    }),
    releaseSkillDeletionClaim: jest.fn(async (): Promise<void> => {
      order.push('release');
      released();
    }),
    beginSkillDeletion: jest.fn(async () => journal),
    getSkillDeletion: jest.fn(async (): Promise<typeof journal | null> => journal),
    iterateSkillCleanupFiles: jest.fn(async function* () {
      yield await Promise.reject(new Error('storage unavailable'));
    }),
    iterateSkillCleanupIntents: jest.fn(async function* () {}),
    hasInFlightSkillUploads: jest.fn(async () => false),
    listExistingSkillFileIds: jest.fn(async () => []),
    deleteSkillFileAfterBlob: jest.fn(async () => true),
    finalizeSkillDeletion: jest.fn(async () => ({
      deleted: true,
      skillAbsent: true,
      cleanupComplete: true,
      failedCleanupSteps: [],
    })),
    completeSkillDeletion: jest.fn(async () => true),
    reopenSkillDeletion: jest.fn(async () => undefined),
    markSkillUploadIntentCleaned: jest.fn(async () => undefined),
    listAbandonedSkillUploadIntents: jest.fn(async (): Promise<SkillUploadIntentRecord[]> => []),
    claimAbandonedSkillUploadIntent: jest.fn(async () => true),
    refreshAbandonedSkillUploadIntentClaim: jest.fn(async () => true),
    noteAbandonedSkillUploadIntentAttempt: jest.fn(async () => undefined),
    releaseAbandonedSkillUploadIntentClaim: jest.fn(async () => undefined),
    scheduleSkillDeletionRecheck: jest.fn(async () => true),
    scheduleAbandonedSkillUploadIntentRecheck: jest.fn(async () => true),
    skillFileExistsForIntent: jest.fn(async () => false),
  };
  const service = createSkillDeletionService({
    persistence,
    loadConfig: jest.fn(
      async () => ({ skillDeletion: { finalizationEnabled: true } }) as unknown as AppConfig,
    ),
    getStrategyFunctions: jest.fn(() => ({})),
    runAsSystem: async (callback) => callback(),
    logger: { error: jest.fn(), warn: jest.fn() },
  });

  const sweep = service.startSkillDeletionSweep({ sweepIntervalMs: 60_000, claimLeaseMs: 120_000 });
  await releaseObserved;
  sweep.stop();
  expect(order).toEqual(['attempt', 'release']);
  expect(persistence.beginSkillDeletion).toHaveBeenCalledTimes(1);
  expect(persistence.getSkillDeletion).not.toHaveBeenCalled();
  expect(persistence.noteSkillDeletionAttempt).toHaveBeenCalledWith(skillId);
});

it.each([false, true])(
  'reconciles an old intent on an active Skill while preserving a live file row: row=%s',
  async (rowExists) => {
    const skillId = '507f1f77bcf86cd799439011';
    const author = '507f1f77bcf86cd799439012';
    const intent = {
      skillId,
      fileId: 'abandoned-file',
      source: 'local',
      storageKey: '/uploads/abandoned-file',
      author,
      state: rowExists ? ('committed' as const) : ('abandoned' as const),
    };
    let released: () => void = () => undefined;
    const releaseObserved = new Promise<void>((resolve) => {
      released = resolve;
    });
    const deleteFile = jest.fn(async () => undefined);
    const persistence = {
      discoverUnjournaledDeletions: jest.fn(async () => 0),
      listSkillDeletionTombstones: jest.fn(async () => []),
      claimSkillDeletion: jest.fn(async () => true),
      refreshSkillDeletionClaim: jest.fn(async () => true),
      noteSkillDeletionAttempt: jest.fn(async () => undefined),
      releaseSkillDeletionClaim: jest.fn(async () => undefined),
      beginSkillDeletion: jest.fn(async () => null),
      getSkillDeletion: jest.fn(async () => null),
      iterateSkillCleanupFiles: jest.fn(async function* () {}),
      iterateSkillCleanupIntents: jest.fn(async function* () {}),
      hasInFlightSkillUploads: jest.fn(async () => false),
      listExistingSkillFileIds: jest.fn(async () => []),
      deleteSkillFileAfterBlob: jest.fn(async () => true),
      finalizeSkillDeletion: jest.fn(async () => ({
        deleted: false,
        skillAbsent: true,
        cleanupComplete: true,
        failedCleanupSteps: [],
      })),
      completeSkillDeletion: jest.fn(async () => true),
      reopenSkillDeletion: jest.fn(async () => undefined),
      markSkillUploadIntentCleaned: jest.fn(async () => undefined),
      listAbandonedSkillUploadIntents: jest.fn(async () => [intent]),
      claimAbandonedSkillUploadIntent: jest.fn(async () => true),
      refreshAbandonedSkillUploadIntentClaim: jest.fn(async () => true),
      noteAbandonedSkillUploadIntentAttempt: jest.fn(async () => undefined),
      releaseAbandonedSkillUploadIntentClaim: jest.fn(async () => released()),
      scheduleSkillDeletionRecheck: jest.fn(async () => true),
      scheduleAbandonedSkillUploadIntentRecheck: jest.fn(async () => true),
      skillFileExistsForIntent: jest.fn(async () => rowExists),
    };
    const service = createSkillDeletionService({
      persistence,
      loadConfig: jest.fn(async () => undefined),
      getStrategyFunctions: jest.fn(() => ({ deleteFile })),
      runAsSystem: async (callback) => callback(),
      logger: { error: jest.fn(), warn: jest.fn() },
    });

    const sweep = service.startSkillDeletionSweep();
    await releaseObserved;
    sweep.stop();
    expect(deleteFile).toHaveBeenCalledTimes(rowExists ? 0 : 1);
    expect(persistence.markSkillUploadIntentCleaned).toHaveBeenCalledTimes(rowExists ? 0 : 1);
    expect(persistence.scheduleAbandonedSkillUploadIntentRecheck).toHaveBeenCalledWith(
      intent.fileId,
      expect.any(String),
      3_600_000,
    );
    expect(persistence.noteAbandonedSkillUploadIntentAttempt).toHaveBeenCalledWith(intent.fileId);
  },
);

function claimedServiceHarness() {
  const skillId = '507f1f77bcf86cd799439011';
  const journal = { skillId, completedAt: undefined as Date | undefined };
  const files = [
    {
      file_id: 'file-1',
      filepath: '/uploads/file-1',
      source: 'local',
      author: '507f1f77bcf86cd799439012',
    },
  ];
  let held = false;
  const persistence = {
    discoverUnjournaledDeletions: jest.fn(async () => 0),
    listSkillDeletionTombstones: jest.fn(async () => [journal]),
    claimSkillDeletion: jest.fn(async () => {
      if (held) return false;
      held = true;
      return true;
    }),
    refreshSkillDeletionClaim: jest.fn(async () => held),
    noteSkillDeletionAttempt: jest.fn(async () => undefined),
    releaseSkillDeletionClaim: jest.fn(async (): Promise<void> => {
      held = false;
    }),
    scheduleSkillDeletionRecheck: jest.fn(async () => true),
    beginSkillDeletion: jest.fn(async () => journal),
    getSkillDeletion: jest.fn(async (): Promise<typeof journal | null> => journal),
    iterateSkillCleanupFiles: jest.fn(async function* () {
      yield [...files];
    }),
    iterateSkillCleanupIntents: jest.fn(async function* () {}),
    hasInFlightSkillUploads: jest.fn(async () => false),
    listExistingSkillFileIds: jest.fn(async () => []),
    deleteSkillFileAfterBlob: jest.fn(async () => {
      files.length = 0;
      return true;
    }),
    finalizeSkillDeletion: jest.fn(async () => ({
      deleted: true,
      skillAbsent: true,
      cleanupComplete: true,
      failedCleanupSteps: [],
    })),
    completeSkillDeletion: jest.fn(async () => {
      journal.completedAt = new Date();
      return true;
    }),
    reopenSkillDeletion: jest.fn(async () => undefined),
    markSkillUploadIntentCleaned: jest.fn(async () => undefined),
    listAbandonedSkillUploadIntents: jest.fn(async (): Promise<SkillUploadIntentRecord[]> => []),
    claimAbandonedSkillUploadIntent: jest.fn(async () => true),
    refreshAbandonedSkillUploadIntentClaim: jest.fn(async () => true),
    noteAbandonedSkillUploadIntentAttempt: jest.fn(async () => undefined),
    releaseAbandonedSkillUploadIntentClaim: jest.fn(async () => undefined),
    scheduleAbandonedSkillUploadIntentRecheck: jest.fn(async () => true),
    skillFileExistsForIntent: jest.fn(async () => false),
  };
  const deleteFile = jest.fn(async (): Promise<void> => undefined);
  const loadConfig = jest.fn(
    async (): Promise<AppConfig | undefined> =>
      ({ skillDeletion: { finalizationEnabled: true } }) as unknown as AppConfig,
  );
  const logger = { error: jest.fn(), warn: jest.fn() };
  const service = createSkillDeletionService({
    persistence,
    loadConfig,
    getStrategyFunctions: jest.fn(() => ({ deleteFile })),
    runAsSystem: async (callback) => callback(),
    logger,
  });
  return { skillId, persistence, deleteFile, loadConfig, logger, service };
}

it('retries a superseded committed blob after a transient provider failure', async () => {
  const h = claimedServiceHarness();
  const oldIntent: SkillUploadIntentRecord = {
    skillId: h.skillId,
    fileId: 'old-revision',
    source: 'local',
    storageKey: '/uploads/old-revision',
    author: '507f1f77bcf86cd799439012',
    state: 'committed',
  };
  h.persistence.listSkillDeletionTombstones.mockResolvedValue([]);
  h.persistence.getSkillDeletion.mockResolvedValue(null);
  h.persistence.listAbandonedSkillUploadIntents.mockResolvedValue([oldIntent]);
  h.deleteFile.mockRejectedValueOnce(new Error('temporary storage outage'));
  let releaseFirst!: () => void;
  const firstAttempt = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  h.persistence.releaseAbandonedSkillUploadIntentClaim.mockImplementationOnce(async () => {
    releaseFirst();
    return undefined;
  });
  const sweep = h.service.startSkillDeletionSweep();
  await firstAttempt;
  expect(h.persistence.markSkillUploadIntentCleaned).not.toHaveBeenCalled();
  await new Promise((resolve) => setImmediate(resolve));
  await sweep.runOnce();
  sweep.stop();
  expect(h.deleteFile).toHaveBeenCalledTimes(2);
  expect(h.persistence.markSkillUploadIntentCleaned).toHaveBeenCalledWith('old-revision');
});

it('marks deletion but cannot finalize until the writer-drain gate is enabled', async () => {
  const h = claimedServiceHarness();
  h.loadConfig.mockResolvedValue({
    skillDeletion: { finalizationEnabled: false },
  } as unknown as AppConfig);

  const pending = await h.service.deleteSkillById(h.skillId);
  expect(pending).toMatchObject({ found: true, deleted: false, cleanupComplete: false });
  expect(h.persistence.beginSkillDeletion).toHaveBeenCalledWith(h.skillId);
  expect(h.persistence.claimSkillDeletion).not.toHaveBeenCalled();
  expect(h.persistence.finalizeSkillDeletion).not.toHaveBeenCalled();

  h.loadConfig.mockResolvedValue({
    skillDeletion: { finalizationEnabled: true },
  } as unknown as AppConfig);
  const completed = await h.service.deleteSkillById(h.skillId);
  expect(completed.cleanupComplete).toBe(true);
  expect(h.persistence.finalizeSkillDeletion).toHaveBeenCalledTimes(1);
});

it('returns pending when the claim transfers between its final check and completion write', async () => {
  const h = claimedServiceHarness();
  h.persistence.completeSkillDeletion.mockResolvedValueOnce(false);

  const progress = await h.service.deleteSkillById(h.skillId);
  expect(progress).toMatchObject({ found: true, deleted: false, cleanupComplete: false });
  expect(h.persistence.completeSkillDeletion).toHaveBeenCalledWith(h.skillId, expect.any(String));
  expect(h.persistence.releaseSkillDeletionClaim).toHaveBeenCalledTimes(1);
});

it('processes independent deletion tombstones with bounded concurrency', async () => {
  const h = claimedServiceHarness();
  h.persistence.listSkillDeletionTombstones.mockResolvedValue(
    ['507f1f77bcf86cd799439011', '507f1f77bcf86cd799439012', '507f1f77bcf86cd799439013'].map(
      (skillId) => ({ skillId, completedAt: undefined }),
    ),
  );
  h.persistence.claimSkillDeletion.mockResolvedValue(true);
  h.persistence.refreshSkillDeletionClaim.mockResolvedValue(true);
  h.persistence.iterateSkillCleanupFiles.mockImplementation(async function* () {
    yield [
      {
        file_id: 'file-1',
        filepath: '/uploads/file-1',
        source: 'local',
        author: '507f1f77bcf86cd799439012',
      },
      {
        file_id: 'file-2',
        filepath: '/uploads/file-2',
        source: 'local',
        author: '507f1f77bcf86cd799439012',
      },
    ];
  });
  h.persistence.deleteSkillFileAfterBlob.mockResolvedValue(true);
  h.loadConfig.mockResolvedValue({
    skillDeletion: { finalizationEnabled: true },
    fileConfig: { skills: { deletionCleanupConcurrency: 2 } },
  } as unknown as AppConfig);
  let active = 0;
  let peak = 0;
  let allCompleted!: () => void;
  const done = new Promise<void>((resolve) => {
    allCompleted = resolve;
  });
  let completed = 0;
  h.persistence.releaseSkillDeletionClaim.mockImplementation(async () => {
    completed++;
    if (completed === 3) allCompleted();
  });
  h.deleteFile.mockImplementation(async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    active--;
  });

  const sweep = h.service.startSkillDeletionSweep();
  try {
    await done;
    expect(peak).toBe(2);
    expect(h.deleteFile).toHaveBeenCalledTimes(6);
    expect(h.persistence.finalizeSkillDeletion).toHaveBeenCalledTimes(3);
    expect(h.loadConfig).toHaveBeenCalledTimes(1);
  } finally {
    sweep.stop();
  }
});

it('uses the configured claim lease for direct deletion', async () => {
  const h = claimedServiceHarness();
  h.loadConfig.mockResolvedValue({
    skillDeletion: { finalizationEnabled: true, claimLeaseMs: 9_000 },
  } as unknown as AppConfig);
  await h.service.deleteSkillById(h.skillId);
  expect(h.persistence.claimSkillDeletion).toHaveBeenCalledWith(
    h.skillId,
    expect.any(String),
    9_000,
  );
  expect(h.loadConfig).toHaveBeenCalledTimes(1);
  expect(h.persistence.beginSkillDeletion).toHaveBeenCalledTimes(1);
  expect(h.persistence.getSkillDeletion).not.toHaveBeenCalled();
});

it('does not log provider metadata when abandoned-intent cleanup fails', async () => {
  const h = claimedServiceHarness();
  const fileId = 'abandoned-file';
  h.persistence.listSkillDeletionTombstones.mockResolvedValue([]);
  h.persistence.listAbandonedSkillUploadIntents.mockResolvedValue([
    {
      skillId: h.skillId,
      fileId,
      source: 'local',
      storageKey: '/uploads/abandoned-file',
      author: '507f1f77bcf86cd799439012',
      state: 'abandoned',
    },
  ]);
  h.persistence.getSkillDeletion.mockResolvedValue(null);
  h.deleteFile.mockRejectedValue(
    Object.assign(new Error('signed URL: secret-token'), {
      status: 403,
      request: { url: 'https://storage.example/object?signature=secret-token' },
      response: { headers: { authorization: 'secret-token' } },
    }),
  );
  let released!: () => void;
  const done = new Promise<void>((resolve) => {
    released = resolve;
  });
  h.persistence.releaseAbandonedSkillUploadIntentClaim.mockImplementation(async () => {
    released();
    return undefined;
  });

  const sweep = h.service.startSkillDeletionSweep();
  await done;
  sweep.stop();

  expect(h.logger.error).toHaveBeenCalledWith(
    `[skill upload intent] Cleanup failed for ${fileId}:`,
    { type: 'Error', status: 403 },
  );
  expect(JSON.stringify(h.logger.error.mock.calls)).not.toContain('secret-token');
});

it('bounds independent abandoned-intent cleanup without serializing the batch', async () => {
  const h = claimedServiceHarness();
  h.persistence.listSkillDeletionTombstones.mockResolvedValue([]);
  h.persistence.listAbandonedSkillUploadIntents.mockResolvedValue(
    ['file-1', 'file-2', 'file-3'].map((fileId) => ({
      skillId: h.skillId,
      fileId,
      source: 'local',
      storageKey: `/uploads/${fileId}`,
      author: '507f1f77bcf86cd799439012',
      state: 'abandoned' as const,
    })),
  );
  h.persistence.getSkillDeletion.mockResolvedValue(null);
  h.loadConfig.mockResolvedValue({
    fileConfig: { skills: { deletionCleanupConcurrency: 2 } },
  } as AppConfig);
  let active = 0;
  let peak = 0;
  let started = 0;
  let completed = 0;
  const releases: Array<() => void> = [];
  let twoStarted!: () => void;
  let threeStarted!: () => void;
  let allReleased!: () => void;
  const firstPair = new Promise<void>((resolve) => {
    twoStarted = resolve;
  });
  const third = new Promise<void>((resolve) => {
    threeStarted = resolve;
  });
  const done = new Promise<void>((resolve) => {
    allReleased = resolve;
  });
  h.deleteFile.mockImplementation(async () => {
    active++;
    peak = Math.max(peak, active);
    started++;
    if (started === 2) twoStarted();
    if (started === 3) threeStarted();
    await new Promise<void>((resolve) => releases.push(resolve));
    active--;
  });
  h.persistence.releaseAbandonedSkillUploadIntentClaim.mockImplementation(async () => {
    completed++;
    if (completed === 3) allReleased();
    return undefined;
  });

  const sweep = h.service.startSkillDeletionSweep();
  try {
    await firstPair;
    expect(h.deleteFile).toHaveBeenCalledTimes(2);
    releases[0]();
    await third;
    expect(peak).toBe(2);
    for (const release of releases.slice(1)) release();
    await done;
    expect(h.persistence.markSkillUploadIntentCleaned).toHaveBeenCalledTimes(3);
    expect(h.loadConfig).toHaveBeenCalledTimes(2);
  } finally {
    sweep.stop();
  }
});

it('defers tombstone-owned abandoned intents without deleting their blobs again', async () => {
  const h = claimedServiceHarness();
  const intent = {
    skillId: h.skillId,
    fileId: 'tombstone-owned',
    source: 'local',
    storageKey: '/uploads/tombstone-owned',
    author: '507f1f77bcf86cd799439012',
    state: 'abandoned' as const,
  };
  h.persistence.listSkillDeletionTombstones.mockResolvedValue([]);
  h.persistence.listAbandonedSkillUploadIntents.mockResolvedValue([intent]);
  let released: (() => void) | undefined;
  const done = new Promise<void>((resolve) => {
    released = resolve;
  });
  h.persistence.releaseAbandonedSkillUploadIntentClaim.mockImplementation(async () => {
    released?.();
  });
  const sweep = h.service.startSkillDeletionSweep();
  await done;
  sweep.stop();
  expect(h.persistence.scheduleAbandonedSkillUploadIntentRecheck).toHaveBeenCalledWith(
    intent.fileId,
    expect.any(String),
    3_600_000,
  );
  expect(h.deleteFile).not.toHaveBeenCalled();
});

it('returns pending to a direct caller while the sweep owns the same Skill claim', async () => {
  const h = claimedServiceHarness();
  let releasedClaim: (() => void) | undefined;
  const released = new Promise<void>((resolve) => {
    releasedClaim = resolve;
  });
  h.persistence.releaseSkillDeletionClaim.mockImplementation(async () => {
    releasedClaim?.();
  });
  let releaseBlob: (() => void) | undefined;
  let startedBlob: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    startedBlob = resolve;
  });
  h.deleteFile.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        releaseBlob = resolve;
        startedBlob?.();
      }),
  );
  const sweep = h.service.startSkillDeletionSweep();
  await started;
  const pending = await h.service.deleteSkillById(h.skillId);
  expect(pending).toMatchObject({ found: true, cleanupComplete: false });
  expect(h.deleteFile).toHaveBeenCalledTimes(1);
  releaseBlob?.();
  await released;
  sweep.stop();
  expect(h.persistence.finalizeSkillDeletion).toHaveBeenCalledTimes(1);
});

it('treats a deferred completed tombstone as an idempotent direct deletion', async () => {
  const h = claimedServiceHarness();
  const completed = { skillId: h.skillId, completedAt: new Date() };
  h.persistence.beginSkillDeletion.mockResolvedValue(completed);
  h.persistence.getSkillDeletion.mockResolvedValue(completed);
  h.persistence.claimSkillDeletion.mockResolvedValue(false);
  await expect(h.service.deleteSkillById(h.skillId)).resolves.toMatchObject({
    found: true,
    skillAbsent: true,
    cleanupComplete: true,
  });
  expect(h.deleteFile).not.toHaveBeenCalled();
});

it('preserves a completed deletion result when finalization is later disabled', async () => {
  const h = claimedServiceHarness();
  const completed = { skillId: h.skillId, completedAt: new Date() };
  h.persistence.beginSkillDeletion.mockResolvedValue(completed);
  h.loadConfig.mockResolvedValue({
    skillDeletion: { finalizationEnabled: false },
  } as unknown as AppConfig);

  await expect(h.service.deleteSkillById(h.skillId)).resolves.toMatchObject({
    found: true,
    deleted: true,
    skillAbsent: true,
    cleanupComplete: true,
  });
  await expect(h.service.deleteSkillForLegacy(h.skillId)).resolves.toMatchObject({
    deleted: true,
    skillAbsent: true,
    cleanupComplete: true,
  });
  expect(h.persistence.claimSkillDeletion).not.toHaveBeenCalled();
  expect(h.persistence.finalizeSkillDeletion).not.toHaveBeenCalled();
});

it('does not delete a file row after the heartbeat reports a lost claim', async () => {
  jest.useFakeTimers();
  try {
    const h = claimedServiceHarness();
    let releaseBlob: (() => void) | undefined;
    let startedBlob: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      startedBlob = resolve;
    });
    h.deleteFile.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseBlob = resolve;
          startedBlob?.();
        }),
    );
    h.persistence.refreshSkillDeletionClaim
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const deletion = h.service.deleteSkillById(h.skillId);
    await started;
    await jest.advanceTimersByTimeAsync(30_000);
    releaseBlob?.();
    await expect(deletion).resolves.toMatchObject({ found: true, cleanupComplete: false });
    expect(h.persistence.deleteSkillFileAfterBlob).not.toHaveBeenCalled();
    expect(h.persistence.finalizeSkillDeletion).not.toHaveBeenCalled();
  } finally {
    jest.useRealTimers();
  }
});
