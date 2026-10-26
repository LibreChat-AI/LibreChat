import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { runAsSystem, tenantStorage } from '~/config/tenantContext';
import { createSkillLifecycleMethods } from './skillLifecycle';
import { createModels } from '../models';

jest.mock('~/config/winston', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
jest.mock('~/config/meiliLogger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

let mongoServer: MongoMemoryServer;
let lifecycle: ReturnType<typeof createSkillLifecycleMethods>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  lifecycle = createSkillLifecycleMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await mongoose.models.Skill.deleteMany({});
  await mongoose.models.SkillDeletion.deleteMany({});
  await mongoose.models.SkillUploadIntent.deleteMany({});
  await mongoose.models.SkillFile.deleteMany({});
});

async function makeSkill() {
  const author = new mongoose.Types.ObjectId();
  const skill = await mongoose.models.Skill.create({
    name: 'example',
    description: 'Example skill for lifecycle tests',
    body: '',
    author,
    authorName: 'Example',
    tenantId: 'tenant-a',
  });
  return { skill, author };
}

async function completeWithClaim(skillId: mongoose.Types.ObjectId) {
  expect(await lifecycle.claimSkillDeletion(skillId, 'test-worker', 60_000)).toBe(true);
  expect(await lifecycle.completeSkillDeletion(skillId, 'test-worker')).toBe(true);
  await lifecycle.releaseSkillDeletionClaim(skillId, 'test-worker');
}

describe('Skill deletion journal', () => {
  it('pages real file and intent cursors without skipping records changed during cleanup', async () => {
    const { skill, author } = await makeSkill();
    await mongoose.models.SkillFile.insertMany(
      Array.from({ length: 205 }, (_, index) => ({
        skillId: skill._id,
        file_id: `paged-${index}`,
        relativePath: `${index}.md`,
        filename: `${index}.md`,
        filepath: `/uploads/${author}/${index}`,
        source: 'local',
        mimeType: 'text/markdown',
        bytes: 4,
        content: 'must not be loaded during cleanup',
        author,
        tenantId: 'tenant-a',
      })),
    );
    await lifecycle.beginSkillDeletion(skill.id);
    const seen = new Set<string>();
    for await (const files of lifecycle.iterateSkillCleanupFiles(skill.id, 17)) {
      expect(files.length).toBeLessThanOrEqual(17);
      for (const file of files) {
        expect(file.content).toBeUndefined();
        expect(seen.has(file.file_id)).toBe(false);
        seen.add(file.file_id);
        await mongoose.models.SkillFile.deleteOne({ file_id: file.file_id });
      }
    }
    expect(seen.size).toBe(205);
    expect(await lifecycle.hasInFlightSkillUploads(skill.id)).toBe(false);
    const cleaned = new Set<string>();
    for await (const intents of lifecycle.iterateSkillCleanupIntents(skill.id, 17)) {
      expect(intents.length).toBeLessThanOrEqual(17);
      expect(
        await lifecycle.listExistingSkillFileIds(
          skill.id,
          intents.map((intent) => intent.fileId),
        ),
      ).toEqual([]);
      for (const intent of intents) {
        expect(cleaned.has(intent.fileId)).toBe(false);
        cleaned.add(intent.fileId);
        await lifecycle.markSkillUploadIntentCleaned(intent.fileId);
      }
    }
    expect(cleaned.size).toBe(205);
    for await (const _batch of lifecycle.iterateSkillCleanupIntents(skill.id, 17)) {
      throw new Error('Cleaned committed history must not be yielded');
    }
  });

  it.each(['break', 'throw'] as const)(
    'closes a Mongo cleanup cursor when its consumer exits with %s',
    async (mode) => {
      const { skill, author } = await makeSkill();
      await mongoose.models.SkillUploadIntent.insertMany(
        Array.from({ length: 7 }, (_, index) => ({
          skillId: skill._id,
          author,
          fileId: `close-${index}`,
          source: 'local',
          storageKey: `/uploads/${index}`,
          writerId: 'writer',
          state: 'abandoned',
        })),
      );
      const query = mongoose.models.SkillUploadIntent.find();
      const find = jest.spyOn(mongoose.models.SkillUploadIntent, 'find').mockReturnValueOnce(query);
      const cursor = jest.spyOn(query, 'cursor');
      const pages = lifecycle.iterateSkillCleanupIntents(skill.id, 2);
      expect(cursor).not.toHaveBeenCalled();
      await pages[Symbol.asyncIterator]().next();
      const close = jest.spyOn(cursor.mock.results[0].value, 'close');
      try {
        const consume = async () => {
          for await (const batch of pages) {
            expect(batch).toHaveLength(2);
            if (mode === 'throw') throw new Error('consumer failure');
            break;
          }
        };
        if (mode === 'throw') await expect(consume()).rejects.toThrow('consumer failure');
        else await consume();
        expect(close).toHaveBeenCalledTimes(1);
      } finally {
        close.mockRestore();
        cursor.mockRestore();
        find.mockRestore();
      }
    },
  );

  it('indexes only marked Skills for startup and periodic deletion discovery', () => {
    expect(mongoose.models.Skill.schema.indexes()).toContainEqual([
      { deletionNeedsJournal: 1, deletionJournalAttemptAt: 1, deletingAt: 1 },
      expect.objectContaining({ sparse: true }),
    ]);
  });

  it('skips not-due completed history instead of scanning the idle tombstone corpus', async () => {
    const model = mongoose.models.SkillDeletion;
    await model.init();
    const now = new Date();
    await model.insertMany(
      Array.from({ length: 1_000 }, () => ({
        skillId: new mongoose.Types.ObjectId(),
        author: new mongoose.Types.ObjectId(),
        startedAt: now,
        completedAt: now,
        lastAttemptAt: now,
        nextCheckAt: new Date(now.getTime() + 3_600_000),
      })),
    );
    const find = jest.spyOn(model.collection, 'find');
    expect(await lifecycle.listSkillDeletionTombstones()).toEqual([]);
    const filter = find.mock.calls[0][0];
    if (!filter) throw new Error('Expected the lifecycle query to reach MongoDB');
    find.mockRestore();
    const plan = await model.collection
      .find(filter)
      .sort({ lastAttemptAt: 1, startedAt: 1 })
      .limit(100)
      .explain('executionStats');
    expect(plan.executionStats.nReturned).toBe(0);
    expect(plan.executionStats.totalDocsExamined).toBeLessThan(50);
    expect(plan.executionStats.totalKeysExamined).toBeLessThan(50);
  });

  it('excludes healthy committed uploads without scanning every live upload during idle cleanup', async () => {
    const model = mongoose.models.SkillUploadIntent;
    await model.init();
    const skillId = new mongoose.Types.ObjectId();
    const author = new mongoose.Types.ObjectId();
    await model.insertMany(
      Array.from({ length: 1_000 }, (_, index) => ({
        skillId,
        author,
        fileId: `healthy-${index}`,
        writerId: 'finished-writer',
        state: 'committed',
        source: 'local',
        storageKey: `/uploads/${author}/healthy-${index}`,
      })),
    );
    const find = jest.spyOn(model.collection, 'find');
    expect(await lifecycle.listAbandonedSkillUploadIntents()).toEqual([]);
    const filter = find.mock.calls[0][0];
    if (!filter) throw new Error('Expected the lifecycle query to reach MongoDB');
    find.mockRestore();
    const plan = await model.collection
      .find(filter)
      .sort({ lastCleanupAttemptAt: 1, createdAt: 1 })
      .limit(100)
      .explain('executionStats');
    expect(plan.executionStats.nReturned).toBe(0);
    expect(plan.executionStats.totalDocsExamined).toBeLessThan(50);
    expect(plan.executionStats.totalKeysExamined).toBeLessThan(50);
  });

  it('keeps inspection history while cleanup excludes only already-cleaned committed uploads', async () => {
    const model = mongoose.models.SkillUploadIntent;
    await model.init();
    const skillId = new mongoose.Types.ObjectId();
    const author = new mongoose.Types.ObjectId();
    const base = {
      skillId,
      author,
      writerId: 'writer',
      source: 'local',
      storageKey: '/uploads/fixture',
    };
    await model.insertMany([
      ...Array.from({ length: 1_000 }, (_, index) => ({
        ...base,
        fileId: `history-${index}`,
        state: 'committed',
        cleanedAt: new Date(),
      })),
      { ...base, fileId: 'uploading', state: 'uploading' },
      { ...base, fileId: 'committing', state: 'committing' },
      { ...base, fileId: 'uncleaned-committed', state: 'committed' },
      { ...base, fileId: 'abandoned', state: 'abandoned' },
      { ...base, fileId: 'cleaned-abandoned', state: 'abandoned', cleanedAt: new Date() },
    ]);
    expect(await lifecycle.listSkillUploadIntents(skillId)).toHaveLength(1_005);
    const find = jest.spyOn(model.collection, 'find');
    const cleanup = await lifecycle.listSkillUploadIntents(skillId, { cleanupOnly: true });
    const filter = find.mock.calls[0][0];
    find.mockRestore();
    expect(cleanup.map((intent) => intent.fileId).sort()).toEqual([
      'abandoned',
      'cleaned-abandoned',
      'committing',
      'uncleaned-committed',
      'uploading',
    ]);
    if (!filter) throw new Error('Expected the cleanup query to reach MongoDB');
    const plan = await model.collection.find(filter).explain('executionStats');
    expect(plan.executionStats.nReturned).toBe(5);
    expect(plan.executionStats.totalDocsExamined).toBeLessThan(50);
    expect(plan.executionStats.totalKeysExamined).toBeLessThan(50);
  });

  it('marks a skill before recording its retryable tombstone', async () => {
    const { skill } = await makeSkill();
    const result = await lifecycle.beginSkillDeletion(skill.id);
    expect(result).toMatchObject({ skillId: skill._id, tenantId: 'tenant-a' });
    const stored = (await mongoose.models.Skill.findById(skill.id).lean()) as {
      deletingAt?: Date;
    } | null;
    expect(stored?.deletingAt).toBeInstanceOf(Date);
    expect(await lifecycle.discoverUnjournaledDeletions()).toBe(0);
    await lifecycle.beginSkillDeletion(skill.id);
    expect(await mongoose.models.SkillDeletion.countDocuments({ skillId: skill._id })).toBe(1);
  });

  it('scopes lifecycle journals and upload intents to the active tenant', async () => {
    const { skill, author } = await makeSkill();
    await lifecycle.beginSkillDeletion(skill.id);
    await expect(
      lifecycle.reserveSkillUploadIntent({
        skillId: skill.id,
        fileId: 'tenant-a-intent',
        source: 'local',
        storageKey: `/uploads/${author}/tenant-a-intent`,
        author: author.toString(),
        tenantId: 'tenant-a',
        writerId: 'tenant-a-writer',
      }),
    ).rejects.toMatchObject({ code: 'SKILL_DELETING' });

    await tenantStorage.run({ tenantId: 'tenant-b' }, async () => {
      expect(await lifecycle.beginSkillDeletion(skill.id)).toBeNull();
      expect(await lifecycle.getSkillDeletion(skill.id)).toBeNull();
      expect(await lifecycle.getSkillUploadIntent('tenant-a-intent')).toBeNull();
      expect(await lifecycle.listPendingSkillDeletions()).toEqual([]);
      expect(await lifecycle.listAbandonedSkillUploadIntents()).toEqual([]);
      expect(
        await lifecycle.transitionSkillUploadIntent(
          'tenant-a-intent',
          'tenant-a-writer',
          'abandoned',
          'committed',
        ),
      ).toBe(false);
    });

    expect(await runAsSystem(() => lifecycle.getSkillDeletion(skill.id))).not.toBeNull();
    expect(
      await runAsSystem(() => lifecycle.getSkillUploadIntent('tenant-a-intent')),
    ).not.toBeNull();
  });

  it('releases the public name at the deletion mark without dropping the unique index', async () => {
    const { skill, author } = await makeSkill();
    await mongoose.models.Skill.init();

    await lifecycle.beginSkillDeletion(skill.id);
    expect(
      ((await mongoose.models.Skill.findById(skill.id).lean()) as { name: string } | null)?.name,
    ).toBe(`__deleted__${skill.id}`);
    const replacement = await mongoose.models.Skill.create({
      name: 'example',
      description: 'Replacement',
      body: '',
      author,
      authorName: 'Example',
      tenantId: 'tenant-a',
    });
    expect(replacement.name).toBe('example');
    await lifecycle.beginSkillDeletion(skill.id);
    expect(
      ((await mongoose.models.Skill.findById(skill.id).lean()) as { name: string } | null)?.name,
    ).toBe(`__deleted__${skill.id}`);
  });

  it('repairs a crash between the Skill mark and tombstone insert', async () => {
    const { skill } = await makeSkill();
    await mongoose.models.Skill.updateOne(
      { _id: skill._id },
      { $set: { deletingAt: new Date(), deletionNeedsJournal: true } },
    );
    expect(await mongoose.models.SkillDeletion.countDocuments({})).toBe(0);
    expect(await lifecycle.discoverUnjournaledDeletions()).toBe(1);
    expect(await lifecycle.discoverUnjournaledDeletions()).toBe(0);
    expect(await mongoose.models.SkillDeletion.countDocuments({ skillId: skill._id })).toBe(1);
  });

  it('bounds discovery and rotates a failed backfill behind other marked Skills', async () => {
    const first = await makeSkill();
    const second = await makeSkill();
    const third = await makeSkill();
    for (const [index, item] of [first, second, third].entries()) {
      await mongoose.models.Skill.updateOne(
        { _id: item.skill._id },
        {
          $set: {
            deletingAt: new Date(Date.now() - (3 - index) * 1_000),
            deletionNeedsJournal: true,
          },
        },
      );
    }
    await mongoose.models.SkillFile.create({
      skillId: first.skill._id,
      file_id: 'failed-backfill',
      relativePath: 'references/failed.md',
      filename: 'failed.md',
      filepath: `/uploads/${first.author}/failed-backfill`,
      source: 'local',
      mimeType: 'text/markdown',
      bytes: 4,
      author: first.author,
      tenantId: 'tenant-a',
    });
    const write = jest
      .spyOn(mongoose.models.SkillUploadIntent, 'bulkWrite')
      .mockRejectedValueOnce(new Error('temporary database failure'));
    try {
      expect(await lifecycle.discoverUnjournaledDeletions(1)).toBe(0);
    } finally {
      write.mockRestore();
    }
    expect(await lifecycle.discoverUnjournaledDeletions(1)).toBe(1);
    expect(await mongoose.models.SkillDeletion.exists({ skillId: second.skill._id })).toBeTruthy();
    expect(await lifecycle.discoverUnjournaledDeletions(1)).toBe(1);
    expect(await mongoose.models.SkillDeletion.exists({ skillId: third.skill._id })).toBeTruthy();
    expect(await lifecycle.discoverUnjournaledDeletions(1)).toBe(1);
    expect(await mongoose.models.SkillDeletion.exists({ skillId: first.skill._id })).toBeTruthy();
    expect(await lifecycle.discoverUnjournaledDeletions(1)).toBe(0);
  });

  it('retries a partially backfilled deletion without rescanning it after success', async () => {
    const { skill, author } = await makeSkill();
    await mongoose.models.SkillFile.create({
      skillId: skill._id,
      file_id: 'legacy-file',
      relativePath: 'references/legacy.md',
      filename: 'legacy.md',
      filepath: `/uploads/${author}/legacy-file`,
      source: 'local',
      mimeType: 'text/markdown',
      bytes: 4,
      author,
      tenantId: 'tenant-a',
    });
    const write = jest
      .spyOn(mongoose.models.SkillUploadIntent, 'bulkWrite')
      .mockRejectedValueOnce(new Error('database unavailable'));
    try {
      await expect(lifecycle.beginSkillDeletion(skill.id)).rejects.toThrow('database unavailable');
    } finally {
      write.mockRestore();
    }
    expect(await mongoose.models.SkillDeletion.countDocuments({ skillId: skill._id })).toBe(1);
    expect(await lifecycle.discoverUnjournaledDeletions()).toBe(1);
    expect(await lifecycle.listSkillUploadIntents(skill._id)).toMatchObject([
      { fileId: 'legacy-file', state: 'committed' },
    ]);
    expect(await lifecycle.discoverUnjournaledDeletions()).toBe(0);
  });

  it('backfills many legacy file references in bounded batches before clearing the marker', async () => {
    const { skill, author } = await makeSkill();
    await mongoose.models.SkillFile.insertMany(
      Array.from({ length: 205 }, (_, index) => ({
        skillId: skill._id,
        file_id: `legacy-file-${index}`,
        relativePath: `references/${index}.md`,
        filename: `${index}.md`,
        filepath: `/uploads/${author}/legacy-file-${index}`,
        source: 'local',
        mimeType: 'text/markdown',
        bytes: 4,
        author,
        tenantId: 'tenant-a',
      })),
    );
    const write = jest.spyOn(mongoose.models.SkillUploadIntent, 'bulkWrite');
    try {
      await lifecycle.beginSkillDeletion(skill.id);
      expect(write.mock.calls.map(([operations]) => operations.length)).toEqual([100, 100, 5]);
    } finally {
      write.mockRestore();
    }
    expect(await mongoose.models.SkillUploadIntent.countDocuments({ skillId: skill._id })).toBe(
      205,
    );
    expect(
      await mongoose.models.SkillUploadIntent.countDocuments({
        skillId: skill._id,
        tenantId: 'tenant-a',
      }),
    ).toBe(205);
    expect(
      (
        (await mongoose.models.Skill.findById(skill.id).lean()) as {
          deletionNeedsJournal?: boolean;
        }
      )?.deletionNeedsJournal,
    ).toBeUndefined();
  });

  it('resumes after a later backfill batch fails without losing acknowledged references', async () => {
    const { skill, author } = await makeSkill();
    await mongoose.models.SkillFile.insertMany(
      Array.from({ length: 101 }, (_, index) => ({
        skillId: skill._id,
        file_id: `resume-file-${index}`,
        relativePath: `references/${index}.md`,
        filename: `${index}.md`,
        filepath: `/uploads/${author}/resume-file-${index}`,
        source: 'local',
        mimeType: 'text/markdown',
        bytes: 4,
        author,
        tenantId: 'tenant-a',
      })),
    );
    const intentModel = mongoose.models.SkillUploadIntent;
    const originalWrite = intentModel.bulkWrite.bind(intentModel);
    const write = jest
      .spyOn(intentModel, 'bulkWrite')
      .mockImplementationOnce((...args) => originalWrite(...args))
      .mockRejectedValueOnce(new Error('second batch failed'));
    try {
      await expect(lifecycle.beginSkillDeletion(skill.id)).rejects.toThrow('second batch failed');
    } finally {
      write.mockRestore();
    }
    expect(await intentModel.countDocuments({ skillId: skill._id })).toBe(100);
    expect(
      (
        (await mongoose.models.Skill.findById(skill.id).lean()) as {
          deletionNeedsJournal?: boolean;
        }
      )?.deletionNeedsJournal,
    ).toBe(true);
    expect(await lifecycle.discoverUnjournaledDeletions()).toBe(1);
    expect(await intentModel.countDocuments({ skillId: skill._id })).toBe(101);
    expect(await lifecycle.discoverUnjournaledDeletions()).toBe(0);
  });

  it('retains completed tombstones for late file reconciliation', async () => {
    const { skill } = await makeSkill();
    await lifecycle.beginSkillDeletion(skill.id);
    await completeWithClaim(skill._id);
    expect(await lifecycle.listPendingSkillDeletions()).toHaveLength(0);
    expect(await lifecycle.listSkillDeletionTombstones()).toHaveLength(1);
    await lifecycle.reopenSkillDeletion(skill._id);
    expect(await lifecycle.listPendingSkillDeletions()).toHaveLength(1);
  });

  it('rediscovers a late upload intent after completion and method reconstruction', async () => {
    const { skill, author } = await makeSkill();
    await lifecycle.beginSkillDeletion(skill.id);
    await completeWithClaim(skill._id);
    // An upload that passed the initial Skill check before deletion may commit
    // its intent after an earlier clean sweep. The tombstone must survive it.
    await mongoose.models.SkillUploadIntent.create({
      skillId: skill._id,
      author,
      tenantId: 'tenant-a',
      fileId: 'late-file',
      source: 'local',
      storageKey: `/uploads/${author}/late-file`,
      writerId: 'stale-writer',
      state: 'abandoned',
    });
    const restarted = createSkillLifecycleMethods(mongoose);
    expect(await restarted.listSkillDeletionTombstones()).toHaveLength(1);
    expect(await restarted.listSkillUploadIntents(skill._id)).toMatchObject([
      { fileId: 'late-file', state: 'abandoned' },
    ]);
  });
});

describe('Skill upload intents', () => {
  it('requires an active Skill and fences state changes by the writer id', async () => {
    const { skill, author } = await makeSkill();
    await lifecycle.reserveSkillUploadIntent({
      skillId: skill.id,
      fileId: 'file-1',
      source: 'local',
      storageKey: 'uploads/author/file-1',
      author: author.toString(),
      tenantId: 'tenant-a',
      writerId: 'worker-1',
    });
    expect(
      await lifecycle.transitionSkillUploadIntent('file-1', 'worker-2', 'uploading', 'committing'),
    ).toBe(false);
    expect(
      await lifecycle.transitionSkillUploadIntent('file-1', 'worker-1', 'uploading', 'committing'),
    ).toBe(true);
    expect(
      await lifecycle.transitionSkillUploadIntent('file-1', 'worker-1', 'uploading', 'committing'),
    ).toBe(true);
    expect(
      await lifecycle.transitionSkillUploadIntent('file-1', 'worker-1', 'committing', 'committed'),
    ).toBe(true);
    expect(
      await lifecycle.transitionSkillUploadIntent('file-1', 'worker-1', 'committing', 'committed'),
    ).toBe(true);
    await lifecycle.beginSkillDeletion(skill.id);
    await expect(
      lifecycle.reserveSkillUploadIntent({
        skillId: skill.id,
        fileId: 'file-2',
        source: 'local',
        storageKey: 'uploads/author/file-2',
        author: author.toString(),
        tenantId: 'tenant-a',
        writerId: 'worker-1',
      }),
    ).rejects.toMatchObject({ code: 'SKILL_DELETING' });
    expect((await lifecycle.getSkillUploadIntent('file-2'))?.state).toBe('abandoned');
  });

  it('makes an in-flight reservation visible before deletion marks the Skill', async () => {
    const { skill, author } = await makeSkill();
    const model = mongoose.models.Skill;
    const findOne = jest.spyOn(model, 'findOne').mockImplementationOnce(
      () =>
        ({
          select: () => ({
            lean: async () => {
              expect((await lifecycle.getSkillUploadIntent('racing-file'))?.state).toBe(
                'uploading',
              );
              await lifecycle.beginSkillDeletion(skill.id);
              return null;
            },
          }),
        }) as never,
    );
    try {
      await expect(
        lifecycle.reserveSkillUploadIntent({
          skillId: skill.id,
          fileId: 'racing-file',
          source: 'local',
          storageKey: `/uploads/${author}/racing-file`,
          author: author.toString(),
          writerId: 'racing-writer',
        }),
      ).rejects.toMatchObject({ code: 'SKILL_DELETING' });
      expect((await lifecycle.getSkillUploadIntent('racing-file'))?.state).toBe('abandoned');
      expect(await lifecycle.getSkillDeletion(skill.id)).not.toBeNull();
    } finally {
      findOne.mockRestore();
    }
  });

  it('abandons a persisted reservation when its insert acknowledgement is lost', async () => {
    const { skill, author } = await makeSkill();
    const model = mongoose.models.SkillUploadIntent;
    const create = model.create.bind(model);
    const spy = jest.spyOn(model, 'create').mockImplementationOnce(async (input) => {
      await create(input);
      throw new Error('insert acknowledgement lost');
    });
    try {
      await expect(
        lifecycle.reserveSkillUploadIntent({
          skillId: skill.id,
          fileId: 'unacknowledged-file',
          source: 'local',
          storageKey: `/uploads/${author}/unacknowledged-file`,
          author: author.toString(),
          writerId: 'unacknowledged-writer',
        }),
      ).rejects.toThrow('insert acknowledgement lost');
      expect((await lifecycle.getSkillUploadIntent('unacknowledged-file'))?.state).toBe(
        'abandoned',
      );
    } finally {
      spy.mockRestore();
    }
  });

  it('backfills a pre-existing blob before its Skill row can be finalized', async () => {
    const { skill, author } = await makeSkill();
    await mongoose.models.SkillFile.create({
      skillId: skill._id,
      file_id: 'legacy-file',
      relativePath: 'references/legacy.md',
      filename: 'legacy.md',
      filepath: `/uploads/${author}/legacy-file`,
      source: 'local',
      mimeType: 'text/markdown',
      bytes: 4,
      author,
      tenantId: 'tenant-a',
    });
    await lifecycle.beginSkillDeletion(skill.id);
    const [intent] = await lifecycle.listSkillUploadIntents(skill._id);
    expect(intent).toMatchObject({
      fileId: 'legacy-file',
      source: 'local',
      storageKey: `/uploads/${author}/legacy-file`,
      state: 'committed',
    });
    await mongoose.models.SkillFile.deleteMany({ skillId: skill._id });
    expect(await lifecycle.listSkillUploadIntents(skill._id)).toHaveLength(1);
    await lifecycle.markSkillUploadIntentCleaned('legacy-file');
    expect((await lifecycle.listSkillUploadIntents(skill._id))[0].cleanedAt).toBeInstanceOf(Date);
  });

  it('backfills the canonical storage key instead of a public file URL', async () => {
    const { skill, author } = await makeSkill();
    await mongoose.models.SkillFile.create({
      skillId: skill._id,
      file_id: 'remote-legacy-file',
      relativePath: 'references/remote.md',
      filename: 'remote.md',
      filepath: 'https://cdn.example.test/temporary-signed-url',
      storageKey: `skills/${author}/remote-legacy-file`,
      source: 's3',
      mimeType: 'text/markdown',
      bytes: 4,
      author,
      tenantId: 'tenant-a',
    });

    await lifecycle.beginSkillDeletion(skill.id);
    expect(await lifecycle.getSkillUploadIntent('remote-legacy-file')).toMatchObject({
      storageKey: `skills/${author}/remote-legacy-file`,
      tenantId: 'tenant-a',
    });
  });

  it('queues a committed rolled-back upload for retry and records successful cleanup', async () => {
    const { skill, author } = await makeSkill();
    await mongoose.models.SkillUploadIntent.create({
      skillId: skill._id,
      fileId: 'rolled-back-file',
      source: 'local',
      storageKey: `/uploads/${author}/rolled-back-file`,
      author,
      tenantId: 'tenant-a',
      writerId: 'sync-writer',
      state: 'committed',
    });
    await lifecycle.queueCommittedSkillUploadCleanup('rolled-back-file');
    expect(
      (await lifecycle.listAbandonedSkillUploadIntents()).map((intent) => intent.fileId),
    ).toContain('rolled-back-file');
    await lifecycle.markSkillUploadIntentCleaned('rolled-back-file');
    expect((await lifecycle.getSkillUploadIntent('rolled-back-file'))?.cleanedAt).toBeInstanceOf(
      Date,
    );
  });

  it('serializes sweep claims and permits retry after expiry', async () => {
    const { skill } = await makeSkill();
    await lifecycle.beginSkillDeletion(skill.id);
    expect(await lifecycle.claimSkillDeletion(skill._id, 'worker-a', 60_000)).toBe(true);
    expect(await lifecycle.listSkillDeletionTombstones()).toHaveLength(0);
    expect(await lifecycle.claimSkillDeletion(skill._id, 'worker-b', 60_000)).toBe(false);
    await lifecycle.releaseSkillDeletionClaim(skill._id, 'worker-a');
    expect(await lifecycle.claimSkillDeletion(skill._id, 'worker-b', 60_000)).toBe(true);
  });

  it('does not complete a deletion after its claim expires or transfers', async () => {
    const { skill } = await makeSkill();
    await lifecycle.beginSkillDeletion(skill.id);
    expect(await lifecycle.claimSkillDeletion(skill._id, 'worker-a', 60_000)).toBe(true);
    await mongoose.models.SkillDeletion.updateOne(
      { skillId: skill._id },
      { $set: { claimExpiresAt: new Date(Date.now() - 1) } },
    );
    expect(await lifecycle.completeSkillDeletion(skill._id, 'worker-a')).toBe(false);
    expect(await lifecycle.claimSkillDeletion(skill._id, 'worker-b', 60_000)).toBe(true);
    expect(await lifecycle.completeSkillDeletion(skill._id, 'worker-a')).toBe(false);
    expect((await lifecycle.getSkillDeletion(skill.id))?.completedAt).toBeUndefined();
    expect(await lifecycle.completeSkillDeletion(skill._id, 'worker-b')).toBe(true);
    expect((await lifecycle.getSkillDeletion(skill.id))?.completedAt).toBeInstanceOf(Date);
  });

  it('retains a lease when a refresh matches without changing its expiry', async () => {
    const { skill, author } = await makeSkill();
    await lifecycle.beginSkillDeletion(skill.id);
    await mongoose.models.SkillUploadIntent.create({
      skillId: skill._id,
      fileId: 'abandoned-refresh',
      source: 'local',
      storageKey: `/uploads/${author}/abandoned-refresh`,
      author,
      writerId: 'stopped',
      state: 'abandoned',
    });
    const deletionWrite = jest
      .spyOn(mongoose.models.SkillDeletion, 'updateOne')
      .mockResolvedValueOnce({
        acknowledged: true,
        matchedCount: 1,
        modifiedCount: 0,
        upsertedCount: 0,
        upsertedId: null,
      });
    const intentWrite = jest
      .spyOn(mongoose.models.SkillUploadIntent, 'updateOne')
      .mockResolvedValueOnce({
        acknowledged: true,
        matchedCount: 1,
        modifiedCount: 0,
        upsertedCount: 0,
        upsertedId: null,
      });
    try {
      expect(await lifecycle.refreshSkillDeletionClaim(skill._id, 'worker-a', 60_000)).toBe(true);
      expect(
        await lifecycle.refreshAbandonedSkillUploadIntentClaim(
          'abandoned-refresh',
          'worker-a',
          60_000,
        ),
      ).toBe(true);
    } finally {
      deletionWrite.mockRestore();
      intentWrite.mockRestore();
    }
  });

  it('defers clean tombstones but admits them after the recheck deadline', async () => {
    const { skill } = await makeSkill();
    await lifecycle.beginSkillDeletion(skill.id);
    await completeWithClaim(skill._id);
    expect(await lifecycle.claimSkillDeletion(skill._id, 'worker-a', 60_000)).toBe(true);
    expect(await lifecycle.scheduleSkillDeletionRecheck(skill._id, 'worker-b', 3_600_000)).toBe(
      false,
    );
    expect(await lifecycle.scheduleSkillDeletionRecheck(skill._id, 'worker-a', 3_600_000)).toBe(
      true,
    );
    await lifecycle.releaseSkillDeletionClaim(skill._id, 'worker-a');
    expect(await lifecycle.listSkillDeletionTombstones()).toHaveLength(0);
    expect(await lifecycle.claimSkillDeletion(skill._id, 'worker-b', 60_000)).toBe(false);
    await mongoose.models.SkillDeletion.updateOne(
      { skillId: skill._id },
      { $set: { nextCheckAt: new Date(Date.now() - 1) } },
    );
    expect(await lifecycle.listSkillDeletionTombstones()).toHaveLength(1);
    expect(await lifecycle.claimSkillDeletion(skill._id, 'worker-b', 60_000)).toBe(true);
    await lifecycle.reopenSkillDeletion(skill._id);
    const reopened = await lifecycle.getSkillDeletion(skill.id);
    expect(reopened?.completedAt).toBeUndefined();
    expect(reopened?.nextCheckAt).toBeUndefined();
  });

  it('recovers a verified-stopped writer without deleting a persisted file', async () => {
    const { skill, author } = await makeSkill();
    await lifecycle.reserveSkillUploadIntent({
      skillId: skill.id,
      fileId: 'orphan-file',
      source: 'local',
      storageKey: `/uploads/${author}/orphan-file`,
      author: author.toString(),
      writerId: 'stopped-writer',
    });
    expect(await lifecycle.recoverStoppedSkillUploadIntent('orphan-file', 'wrong-writer')).toEqual({
      status: 'changed',
    });
    expect(
      await lifecycle.recoverStoppedSkillUploadIntent('orphan-file', 'stopped-writer'),
    ).toEqual({
      status: 'recovered',
      state: 'abandoned',
    });
    expect((await lifecycle.getSkillUploadIntent('orphan-file'))?.state).toBe('abandoned');

    await lifecycle.reserveSkillUploadIntent({
      skillId: skill.id,
      fileId: 'persisted-file',
      source: 'local',
      storageKey: `/uploads/${author}/persisted-file`,
      author: author.toString(),
      writerId: 'stopped-writer',
    });
    await lifecycle.transitionSkillUploadIntent(
      'persisted-file',
      'stopped-writer',
      'uploading',
      'committing',
    );
    await mongoose.models.SkillFile.create({
      skillId: skill._id,
      file_id: 'persisted-file',
      relativePath: 'references/persisted.md',
      filename: 'persisted.md',
      filepath: `/uploads/${author}/persisted-file`,
      source: 'local',
      mimeType: 'text/markdown',
      bytes: 4,
      author,
    });
    expect(
      await lifecycle.recoverStoppedSkillUploadIntent('persisted-file', 'stopped-writer'),
    ).toEqual({
      status: 'recovered',
      state: 'committed',
    });
    expect(await lifecycle.listAbandonedSkillUploadIntents()).toHaveLength(1);
    expect(await lifecycle.claimAbandonedSkillUploadIntent('orphan-file', 'worker-a', 60_000)).toBe(
      true,
    );
    expect(await lifecycle.listAbandonedSkillUploadIntents()).toHaveLength(0);
    expect(await lifecycle.claimAbandonedSkillUploadIntent('orphan-file', 'worker-b', 60_000)).toBe(
      false,
    );
    await lifecycle.noteAbandonedSkillUploadIntentAttempt('orphan-file');
    await lifecycle.releaseAbandonedSkillUploadIntentClaim('orphan-file', 'worker-a');
    expect(
      (await lifecycle.getSkillUploadIntent('orphan-file'))?.lastCleanupAttemptAt,
    ).toBeInstanceOf(Date);
  });

  it('retains an existing cleanup lease after cleaning a committed intent without making it claimable again', async () => {
    const { skill, author } = await makeSkill();
    const fileId = 'cleaned-committed';
    await mongoose.models.SkillUploadIntent.create({
      skillId: skill._id,
      fileId,
      source: 'local',
      storageKey: `/uploads/${author}/${fileId}`,
      author,
      writerId: 'finished-writer',
      state: 'committed',
      cleanupRequestedAt: new Date(),
    });
    expect(await lifecycle.claimAbandonedSkillUploadIntent(fileId, 'worker-a', 60_000)).toBe(true);
    await lifecycle.markSkillUploadIntentCleaned(fileId);
    expect(await lifecycle.refreshAbandonedSkillUploadIntentClaim(fileId, 'worker-a', 60_000)).toBe(
      true,
    );
    expect(await lifecycle.refreshAbandonedSkillUploadIntentClaim(fileId, 'worker-b', 60_000)).toBe(
      false,
    );
    expect(
      await lifecycle.scheduleAbandonedSkillUploadIntentRecheck(fileId, 'worker-b', 60_000),
    ).toBe(false);
    expect(
      await lifecycle.scheduleAbandonedSkillUploadIntentRecheck(fileId, 'worker-a', 60_000),
    ).toBe(true);
    await lifecycle.noteAbandonedSkillUploadIntentAttempt(fileId);
    const completed = await lifecycle.getSkillUploadIntent(fileId);
    expect(completed?.cleanedAt).toBeInstanceOf(Date);
    expect(completed?.lastCleanupAttemptAt).toBeInstanceOf(Date);

    await mongoose.models.SkillUploadIntent.updateOne(
      { fileId },
      { $set: { claimExpiresAt: new Date(Date.now() - 1) } },
    );
    expect(await lifecycle.refreshAbandonedSkillUploadIntentClaim(fileId, 'worker-a', 60_000)).toBe(
      false,
    );
    expect(
      await lifecycle.scheduleAbandonedSkillUploadIntentRecheck(fileId, 'worker-a', 60_000),
    ).toBe(false);
    await lifecycle.releaseAbandonedSkillUploadIntentClaim(fileId, 'worker-a');
    await mongoose.models.SkillUploadIntent.updateOne(
      { fileId },
      { $set: { nextCheckAt: new Date(Date.now() - 1) } },
    );
    expect(await lifecycle.listAbandonedSkillUploadIntents()).toEqual([]);
    expect(await lifecycle.claimAbandonedSkillUploadIntent(fileId, 'worker-b', 60_000)).toBe(false);
    expect((await lifecycle.getSkillUploadIntent(fileId))?.claimOwner).toBeUndefined();
  });

  it('keeps cleaned abandoned intents as deferred late-upload sentinels', async () => {
    const { skill, author } = await makeSkill();
    await lifecycle.reserveSkillUploadIntent({
      skillId: skill.id,
      fileId: 'late-blob',
      source: 'local',
      storageKey: `/uploads/${author}/late-blob`,
      author: author.toString(),
      writerId: 'writer-a',
    });
    await lifecycle.transitionSkillUploadIntent('late-blob', 'writer-a', 'uploading', 'abandoned');
    expect(await lifecycle.claimAbandonedSkillUploadIntent('late-blob', 'worker-a', 60_000)).toBe(
      true,
    );
    await lifecycle.markSkillUploadIntentCleaned('late-blob');
    expect(
      await lifecycle.scheduleAbandonedSkillUploadIntentRecheck('late-blob', 'worker-b', 3_600_000),
    ).toBe(false);
    expect(
      await lifecycle.scheduleAbandonedSkillUploadIntentRecheck('late-blob', 'worker-a', 3_600_000),
    ).toBe(true);
    await lifecycle.releaseAbandonedSkillUploadIntentClaim('late-blob', 'worker-a');
    expect(await lifecycle.listAbandonedSkillUploadIntents()).toHaveLength(0);
    expect(await lifecycle.claimAbandonedSkillUploadIntent('late-blob', 'worker-b', 60_000)).toBe(
      false,
    );
    await mongoose.models.SkillUploadIntent.updateOne(
      { fileId: 'late-blob' },
      { $set: { nextCheckAt: new Date(Date.now() - 1) } },
    );
    expect(await lifecycle.listAbandonedSkillUploadIntents()).toHaveLength(1);
    expect(await lifecycle.claimAbandonedSkillUploadIntent('late-blob', 'worker-b', 60_000)).toBe(
      true,
    );
  });

  it('can defer an uncleaned abandoned intent while its Skill tombstone owns cleanup', async () => {
    const { skill, author } = await makeSkill();
    await mongoose.models.SkillUploadIntent.create({
      skillId: skill._id,
      fileId: 'tombstone-owned',
      source: 'local',
      storageKey: `/uploads/${author}/tombstone-owned`,
      author,
      writerId: 'stopped',
      state: 'abandoned',
    });
    expect(
      await lifecycle.claimAbandonedSkillUploadIntent('tombstone-owned', 'worker-a', 60_000),
    ).toBe(true);
    expect(
      await lifecycle.scheduleAbandonedSkillUploadIntentRecheck(
        'tombstone-owned',
        'worker-a',
        3_600_000,
      ),
    ).toBe(true);
    await lifecycle.releaseAbandonedSkillUploadIntentClaim('tombstone-owned', 'worker-a');
    expect(await lifecycle.listAbandonedSkillUploadIntents()).toHaveLength(0);
    await mongoose.models.SkillUploadIntent.updateOne(
      { fileId: 'tombstone-owned' },
      { $set: { nextCheckAt: new Date(Date.now() - 1) } },
    );
    expect(await lifecycle.listAbandonedSkillUploadIntents()).toHaveLength(1);
  });

  it('keeps a held committed intent outside every cleanup sweep path until its owner releases it', async () => {
    const { skill, author } = await makeSkill();
    await mongoose.models.SkillUploadIntent.create({
      skillId: skill._id,
      fileId: 'held-file',
      source: 'local',
      storageKey: `/uploads/${author}/held-file`,
      author,
      writerId: 'old-writer',
      state: 'committed',
      cleanupRequestedAt: new Date(),
      cleanupHoldOwner: 'replacement-writer',
      claimOwner: 'sweeper',
      claimExpiresAt: new Date(Date.now() + 60_000),
    });

    expect(await lifecycle.listAbandonedSkillUploadIntents()).toEqual([]);
    expect(await lifecycle.claimAbandonedSkillUploadIntent('held-file', 'sweeper', 60_000)).toBe(
      false,
    );
    expect(
      await lifecycle.refreshAbandonedSkillUploadIntentClaim('held-file', 'sweeper', 60_000),
    ).toBe(false);
    expect(
      await lifecycle.scheduleAbandonedSkillUploadIntentRecheck('held-file', 'sweeper', 60_000),
    ).toBe(false);
    expect(await lifecycle.finishSkillUploadCleanupHold('held-file', 'wrong-writer', true)).toBe(
      false,
    );
    expect(
      await lifecycle.finishSkillUploadCleanupHold('held-file', 'replacement-writer', false),
    ).toBe(true);
    expect((await lifecycle.getSkillUploadIntent('held-file'))?.cleanupRequestedAt).toBeUndefined();
    expect((await lifecycle.getSkillUploadIntent('held-file'))?.cleanupHoldOwner).toBeUndefined();
    expect(await lifecycle.listAbandonedSkillUploadIntents()).toEqual([]);
    expect(
      await lifecycle.finishSkillUploadCleanupHold('held-file', 'replacement-writer', true),
    ).toBe(false);
  });

  it('releases a held original for cleanup when the replacement removed its file row', async () => {
    const { skill, author } = await makeSkill();
    await mongoose.models.SkillUploadIntent.create({
      skillId: skill._id,
      fileId: 'replaced-file',
      source: 'local',
      storageKey: `/uploads/${author}/replaced-file`,
      author,
      writerId: 'old-writer',
      state: 'committed',
      cleanupHoldOwner: 'replacement-writer',
      nextCheckAt: new Date(Date.now() + 3_600_000),
    });

    expect(
      await lifecycle.finishSkillUploadCleanupHold('replaced-file', 'replacement-writer', true),
    ).toBe(true);
    const intent = await lifecycle.getSkillUploadIntent('replaced-file');
    expect(intent?.cleanupHoldOwner).toBeUndefined();
    expect(intent?.cleanupRequestedAt).toBeInstanceOf(Date);
    expect(intent?.nextCheckAt).toBeUndefined();
    expect(
      (await lifecycle.listAbandonedSkillUploadIntents()).map((item) => item.fileId),
    ).toContain('replaced-file');
  });

  it('recovers a stopped cleanup hold according to the original file row', async () => {
    const { skill, author } = await makeSkill();
    await mongoose.models.SkillUploadIntent.create([
      {
        skillId: skill._id,
        fileId: 'still-present',
        source: 'local',
        storageKey: `/uploads/${author}/still-present`,
        author,
        writerId: 'old-writer',
        state: 'committed',
        cleanupHoldOwner: 'stopped-writer',
      },
      {
        skillId: skill._id,
        fileId: 'removed',
        source: 'local',
        storageKey: `/uploads/${author}/removed`,
        author,
        writerId: 'old-writer',
        state: 'committed',
        cleanupHoldOwner: 'stopped-writer',
      },
    ]);
    await mongoose.models.SkillFile.create({
      skillId: skill._id,
      file_id: 'still-present',
      relativePath: 'references/still-present.md',
      filename: 'still-present.md',
      filepath: `/uploads/${author}/still-present`,
      source: 'local',
      mimeType: 'text/markdown',
      bytes: 4,
      author,
    });

    expect(
      await lifecycle.recoverStoppedSkillUploadCleanupHold('missing', 'stopped-writer'),
    ).toEqual({
      status: 'missing',
    });
    expect(
      await lifecycle.recoverStoppedSkillUploadCleanupHold('still-present', 'wrong-writer'),
    ).toEqual({ status: 'changed' });
    expect(
      await lifecycle.recoverStoppedSkillUploadCleanupHold('still-present', 'stopped-writer'),
    ).toEqual({ status: 'recovered', cleanup: false });
    expect(
      (await lifecycle.getSkillUploadIntent('still-present'))?.cleanupRequestedAt,
    ).toBeUndefined();
    expect(
      await lifecycle.recoverStoppedSkillUploadCleanupHold('removed', 'stopped-writer'),
    ).toEqual({
      status: 'recovered',
      cleanup: true,
    });
    expect((await lifecycle.listAbandonedSkillUploadIntents()).map((item) => item.fileId)).toEqual([
      'removed',
    ]);
  });
});
