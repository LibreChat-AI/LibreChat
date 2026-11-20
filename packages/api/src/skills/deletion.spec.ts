import type {
  SkillDeletionFileRecord,
  SkillDeletionRecord,
  SkillUploadIntentRecord,
} from '@librechat/data-schemas';
import type { SkillDeletionDeps } from './deletion';
import { runSkillDeletion, SkillDeletionClaimLostError } from './deletion';

const skillId = '507f1f77bcf86cd799439011';
const author = '507f1f77bcf86cd799439012';
const journal = {
  skillId,
} satisfies SkillDeletionRecord;

async function* batches<Row>(rows: Row[], size: number): AsyncGenerator<Row[]> {
  const snapshot = [...rows];
  for (let offset = 0; offset < snapshot.length; offset += size) {
    yield snapshot.slice(offset, offset + size);
  }
}

function harness() {
  const files = [
    {
      file_id: 'file-1',
      filepath: '/uploads/owner/file-1',
      source: 'local',
      author,
    },
  ] satisfies SkillDeletionFileRecord[];
  const intents: SkillUploadIntentRecord[] = [];
  const deps: SkillDeletionDeps = {
    beginSkillDeletion: jest.fn(async () => journal),
    getSkillDeletion: jest.fn(async () => journal),
    iterateSkillCleanupFiles: jest.fn((_id, size) => batches(files, size)),
    iterateSkillCleanupIntents: jest.fn((_id, size) =>
      batches(
        intents.filter((intent) => intent.state !== 'committed' || !intent.cleanedAt),
        size,
      ),
    ),
    hasInFlightSkillUploads: jest.fn(async () =>
      intents.some((intent) => intent.state === 'uploading' || intent.state === 'committing'),
    ),
    listExistingSkillFileIds: jest.fn(async (_id, ids) =>
      files.filter((file) => ids.includes(file.file_id)).map((file) => file.file_id),
    ),
    deleteBlob: jest.fn(async () => undefined),
    deleteReservedBlob: jest.fn(async () => undefined),
    deleteSkillFileAfterBlob: jest.fn(async (_id, fileId) => {
      const index = files.findIndex((file) => file.file_id === fileId);
      if (index < 0) return false;
      files.splice(index, 1);
      return true;
    }),
    finalizeSkillDeletion: jest.fn(async () => ({
      deleted: true,
      skillAbsent: true,
      cleanupComplete: true,
      failedCleanupSteps: [],
    })),
    completeSkillDeletion: jest.fn(async () => true),
    reopenSkillDeletion: jest.fn(async () => undefined),
    markSkillUploadIntentCleaned: jest.fn(async (fileId) => {
      const intent = intents.find((row) => row.fileId === fileId);
      if (intent) intent.cleanedAt = new Date();
    }),
  };
  return { files, intents, deps };
}

it('keeps the file row when provider deletion fails and succeeds on retry', async () => {
  const h = harness();
  const deleteBlob = h.deps.deleteBlob as jest.Mock;
  deleteBlob.mockRejectedValueOnce(new Error('storage unavailable'));
  await expect(runSkillDeletion(skillId.toString(), h.deps)).resolves.toMatchObject({
    cleanupComplete: false,
    failedSteps: ['skill_files'],
  });
  expect(h.files).toHaveLength(1);
  expect(h.deps.finalizeSkillDeletion).not.toHaveBeenCalled();
  await expect(runSkillDeletion(skillId.toString(), h.deps)).resolves.toMatchObject({
    cleanupComplete: true,
  });
  expect(h.files).toHaveLength(0);
  expect(h.deps.completeSkillDeletion).toHaveBeenCalledTimes(1);
});

it('does not report completion when the claim transfers after its final refresh', async () => {
  const h = harness();
  h.files.length = 0;
  (h.deps.completeSkillDeletion as jest.Mock).mockResolvedValueOnce(false);
  await expect(runSkillDeletion(skillId, h.deps)).rejects.toBeInstanceOf(
    SkillDeletionClaimLostError,
  );
  expect(h.deps.completeSkillDeletion).toHaveBeenCalledWith(skillId);
});

it('preserves idempotent absence and per-call deletion semantics', async () => {
  const h = harness();
  (h.deps.beginSkillDeletion as jest.Mock).mockResolvedValueOnce(null);
  (h.deps.getSkillDeletion as jest.Mock).mockResolvedValueOnce(null);
  await expect(runSkillDeletion(skillId.toString(), h.deps)).resolves.toMatchObject({
    found: false,
    deleted: false,
    skillAbsent: true,
    cleanupComplete: true,
  });

  h.files.length = 0;
  (h.deps.finalizeSkillDeletion as jest.Mock).mockResolvedValueOnce({
    deleted: false,
    skillAbsent: true,
    cleanupComplete: true,
    failedCleanupSteps: [],
  });
  await expect(runSkillDeletion(skillId.toString(), h.deps)).resolves.toMatchObject({
    found: true,
    deleted: false,
    skillAbsent: true,
    cleanupComplete: true,
  });
});

it.each(['uploading', 'committing'] as const)(
  'leaves an in-flight %s writer pending without deleting its blob',
  async (state) => {
    const h = harness();
    h.intents.push({
      skillId,
      author,
      fileId: 'file-1',
      source: 'local',
      storageKey: '/uploads/owner/file-1',
      state,
    });
    await expect(runSkillDeletion(skillId.toString(), h.deps)).resolves.toMatchObject({
      cleanupComplete: false,
      failedSteps: ['upload_intents'],
    });
    expect(h.deps.deleteBlob).not.toHaveBeenCalled();
    expect(h.deps.finalizeSkillDeletion).not.toHaveBeenCalled();
  },
);

it('cleans a committed historical blob after its SkillFile row was replaced', async () => {
  const h = harness();
  h.files.length = 0;
  h.intents.push({
    skillId,
    author,
    fileId: 'old-file',
    source: 'local',
    storageKey: '/uploads/owner/old-file',
    state: 'committed',
  });
  const first = await runSkillDeletion(skillId.toString(), h.deps);
  expect(first.cleanupComplete).toBe(true);
  expect(h.deps.deleteReservedBlob).toHaveBeenCalledTimes(1);
  expect(h.intents[0].cleanedAt).toBeDefined();
  await runSkillDeletion(skillId.toString(), h.deps);
  expect(h.deps.deleteReservedBlob).toHaveBeenCalledTimes(1);
});

it('deletes a current file blob only once when its committed intent points at the same upload', async () => {
  const h = harness();
  h.intents.push({
    skillId,
    author,
    fileId: 'file-1',
    source: 'local',
    storageKey: '/uploads/owner/file-1',
    state: 'committed',
  });
  await expect(runSkillDeletion(skillId.toString(), h.deps)).resolves.toMatchObject({
    cleanupComplete: true,
  });
  expect(h.deps.deleteBlob).toHaveBeenCalledTimes(1);
  expect(h.deps.deleteReservedBlob).not.toHaveBeenCalled();
  expect(h.intents[0].cleanedAt).toBeDefined();
});

it('resweeps abandoned intents even after an earlier clean pass', async () => {
  const h = harness();
  h.files.length = 0;
  h.intents.push({
    skillId,
    author,
    fileId: 'zombie',
    source: 'local',
    storageKey: '/uploads/owner/zombie',
    state: 'abandoned',
  });
  await runSkillDeletion(skillId.toString(), h.deps);
  await runSkillDeletion(skillId.toString(), h.deps);
  expect(h.deps.deleteReservedBlob).toHaveBeenCalledTimes(2);
});

it('cleans intent blobs with bounded concurrency', async () => {
  const h = harness();
  h.files.length = 0;
  for (let index = 0; index < 4; index++) {
    h.intents.push({
      skillId,
      author,
      fileId: `orphan-${index}`,
      source: 'local',
      storageKey: `/uploads/owner/orphan-${index}`,
      state: 'abandoned',
    });
  }
  let active = 0;
  let peak = 0;
  h.deps.deleteReservedBlob = jest.fn(async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setImmediate(resolve));
    active--;
  });

  await runSkillDeletion(skillId, h.deps, 2);
  expect(h.deps.deleteReservedBlob).toHaveBeenCalledTimes(4);
  expect(peak).toBe(2);
});

it('does not reopen or finalize an already-completed tombstone with no late work', async () => {
  const h = harness();
  h.files.length = 0;
  (h.deps.beginSkillDeletion as jest.Mock).mockResolvedValue({
    skillId,
    completedAt: new Date(),
  });
  await expect(runSkillDeletion(skillId, h.deps)).resolves.toMatchObject({
    cleanupComplete: true,
    skillAbsent: true,
  });
  expect(h.deps.reopenSkillDeletion).not.toHaveBeenCalled();
  expect(h.deps.finalizeSkillDeletion).not.toHaveBeenCalled();
  expect(h.deps.completeSkillDeletion).not.toHaveBeenCalled();
});

it('cold-audits an abandoned intent without rerunning completed dependent cleanup', async () => {
  const h = harness();
  h.files.length = 0;
  h.intents.push({
    skillId,
    author,
    fileId: 'late-write',
    source: 'local',
    storageKey: '/uploads/late-write',
    state: 'abandoned',
    cleanedAt: new Date(),
  });
  (h.deps.beginSkillDeletion as jest.Mock).mockResolvedValue({
    skillId,
    completedAt: new Date(),
  });
  await expect(runSkillDeletion(skillId, h.deps)).resolves.toMatchObject({
    cleanupComplete: true,
  });
  expect(h.deps.deleteReservedBlob).toHaveBeenCalledTimes(1);
  expect(h.deps.reopenSkillDeletion).not.toHaveBeenCalled();
  expect(h.deps.finalizeSkillDeletion).not.toHaveBeenCalled();
});

it('reopens completed deletion only when a late file needs cleanup', async () => {
  const h = harness();
  (h.deps.beginSkillDeletion as jest.Mock).mockResolvedValue({
    skillId,
    completedAt: new Date(),
  });
  await expect(runSkillDeletion(skillId, h.deps)).resolves.toMatchObject({
    cleanupComplete: true,
  });
  expect(h.deps.reopenSkillDeletion).toHaveBeenCalledWith(skillId);
  expect(h.deps.deleteBlob).toHaveBeenCalledTimes(1);
  expect(h.deps.finalizeSkillDeletion).toHaveBeenCalledTimes(1);
});

it('does not mutate a file row after losing the claim during its provider delete', async () => {
  const h = harness();
  let releaseBlob: (() => void) | undefined;
  let startedBlob: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    startedBlob = resolve;
  });
  (h.deps.deleteBlob as jest.Mock).mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        releaseBlob = resolve;
        startedBlob?.();
      }),
  );
  let lost = false;
  const assertClaim = jest.fn(async () => {
    if (lost) throw new SkillDeletionClaimLostError();
  });
  const deletion = runSkillDeletion(skillId, h.deps, 1, assertClaim);
  await started;
  lost = true;
  releaseBlob?.();
  await expect(deletion).rejects.toBeInstanceOf(SkillDeletionClaimLostError);
  expect(h.deps.deleteSkillFileAfterBlob).not.toHaveBeenCalled();
  expect(h.deps.finalizeSkillDeletion).not.toHaveBeenCalled();
});

it('bounds independent file cleanup while deleting each row after its blob', async () => {
  const h = harness();
  h.files.push({ ...h.files[0], file_id: 'file-2' }, { ...h.files[0], file_id: 'file-3' });
  let active = 0;
  let peak = 0;
  (h.deps.deleteBlob as jest.Mock).mockImplementation(async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setImmediate(resolve));
    active--;
  });
  await runSkillDeletion(skillId, h.deps, 2);
  expect(peak).toBe(2);
  expect(h.deps.deleteSkillFileAfterBlob).toHaveBeenCalledTimes(3);
  expect(h.files).toHaveLength(0);
});

it('fully settles each file page before requesting the next one', async () => {
  const h = harness();
  const template = h.files[0];
  h.files.splice(
    0,
    1,
    ...Array.from({ length: 11 }, (_, index) => ({ ...template, file_id: `page-file-${index}` })),
  );
  const closed = jest.fn();
  const sizes: number[] = [];
  const original = h.deps.iterateSkillCleanupFiles;
  h.deps.iterateSkillCleanupFiles = async function* (id, size) {
    let processed = 0;
    try {
      for await (const page of original(id, size)) {
        expect(h.deps.deleteSkillFileAfterBlob).toHaveBeenCalledTimes(processed);
        sizes.push(page.length);
        yield page;
        processed += page.length;
      }
    } finally {
      closed();
    }
  };
  await expect(
    runSkillDeletion(skillId, h.deps, 2, undefined, undefined, 3),
  ).resolves.toMatchObject({ cleanupComplete: true });
  expect(sizes).toEqual([3, 3, 3, 2]);
  expect(h.files).toHaveLength(0);
  expect(closed).toHaveBeenCalledTimes(1);
});

it('uses one bounded file lookup per intent page and retries a failed later page', async () => {
  const h = harness();
  h.files.length = 0;
  for (let index = 0; index < 11; index++) {
    h.intents.push({
      skillId,
      author,
      fileId: `intent-${index}`,
      source: 'local',
      storageKey: `/uploads/${index}`,
      state: 'committed',
    });
  }
  (h.deps.deleteReservedBlob as jest.Mock).mockImplementation(
    async (intent: SkillUploadIntentRecord) => {
      if (intent.fileId === 'intent-7') throw new Error('temporary provider failure');
    },
  );
  await expect(
    runSkillDeletion(skillId, h.deps, 2, undefined, undefined, 3),
  ).resolves.toMatchObject({ cleanupComplete: false, failedSteps: ['upload_intents'] });
  expect(h.intents.filter((intent) => !intent.cleanedAt).map((intent) => intent.fileId)).toEqual([
    'intent-7',
  ]);
  expect(h.deps.listExistingSkillFileIds).toHaveBeenCalledTimes(4);
  for (const [, ids] of (h.deps.listExistingSkillFileIds as jest.Mock).mock.calls)
    expect(ids.length).toBeLessThanOrEqual(3);
  (h.deps.deleteReservedBlob as jest.Mock).mockResolvedValue(undefined);
  await expect(
    runSkillDeletion(skillId, h.deps, 2, undefined, undefined, 3),
  ).resolves.toMatchObject({ cleanupComplete: true });
  expect(h.deps.deleteReservedBlob).toHaveBeenCalledTimes(12);
});

it('checks all in-flight writers before opening either cleanup cursor', async () => {
  const h = harness();
  for (let index = 0; index < 20; index++) {
    h.intents.push({
      skillId,
      author,
      fileId: `intent-${index}`,
      source: 'local',
      storageKey: `/uploads/${index}`,
      state: index === 19 ? 'uploading' : 'committed',
    });
  }
  await expect(
    runSkillDeletion(skillId, h.deps, 2, undefined, undefined, 3),
  ).resolves.toMatchObject({ cleanupComplete: false });
  expect(h.deps.iterateSkillCleanupFiles).not.toHaveBeenCalled();
  expect(h.deps.iterateSkillCleanupIntents).not.toHaveBeenCalled();
  expect(h.deps.deleteBlob).not.toHaveBeenCalled();
});

it('closes the current page iterator and does not fetch later pages after claim loss', async () => {
  const h = harness();
  const closed = jest.fn();
  const nextPage = jest.fn();
  h.deps.iterateSkillCleanupFiles = async function* () {
    try {
      yield [...h.files];
      nextPage();
      yield [...h.files];
    } finally {
      closed();
    }
  };
  let lost = false;
  (h.deps.deleteBlob as jest.Mock).mockImplementation(async () => {
    lost = true;
  });
  await expect(
    runSkillDeletion(
      skillId,
      h.deps,
      1,
      async () => {
        if (lost) throw new SkillDeletionClaimLostError();
      },
      undefined,
      1,
    ),
  ).rejects.toBeInstanceOf(SkillDeletionClaimLostError);
  expect(closed).toHaveBeenCalledTimes(1);
  expect(nextPage).not.toHaveBeenCalled();
  expect(h.files).toHaveLength(1);
});

it('bounds repeated failure bookkeeping across pages', async () => {
  const h = harness();
  const template = h.files[0];
  h.files.splice(
    0,
    1,
    ...Array.from({ length: 30 }, (_, index) => ({ ...template, file_id: `failed-${index}` })),
  );
  (h.deps.deleteBlob as jest.Mock).mockRejectedValue(new Error('provider unavailable'));
  await expect(
    runSkillDeletion(skillId, h.deps, 2, undefined, undefined, 3),
  ).resolves.toMatchObject({ failedSteps: ['skill_files'] });
  expect(h.files).toHaveLength(30);
});
