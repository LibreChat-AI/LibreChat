import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  createMethods,
  createModels,
  createSkillDeletionPersistenceAdapter,
  tenantStorage,
} from '@librechat/data-schemas';
import type { AppConfig } from '@librechat/data-schemas';
import { createSkillDeletionService } from './deletionService';

describe('Skill cleanup across a worker restart', () => {
  let mongo: MongoMemoryServer;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    createModels(mongoose);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  });

  it('finishes a superseded committed upload without reporting successful cleanup as a lost claim', async () => {
    const db = createMethods(mongoose);
    const author = new Types.ObjectId();
    const { skill } = await db.createSkill({
      name: 'completed-upload',
      description: 'Exercise cleanup completion with real persistence.',
      body: 'Instructions.',
      author,
      authorName: 'Test',
    });
    const fileId = 'completed-upload-file';
    await mongoose.models.SkillUploadIntent.create({
      skillId: skill._id,
      fileId,
      source: 's3',
      storageKey: `uploads/${author}/old.txt`,
      author,
      writerId: 'finished-writer',
      state: 'committed',
      cleanupRequestedAt: new Date(),
    });
    const deleteFile = jest.fn(async () => undefined);
    const logger = { error: jest.fn(), warn: jest.fn() };
    const service = createSkillDeletionService({
      persistence: { ...db, ...createSkillDeletionPersistenceAdapter(db) },
      loadConfig: async () => undefined,
      getStrategyFunctions: () => ({ deleteFile }),
      runAsSystem: async (callback) => callback(),
      logger,
    });
    const sweep = service.startSkillDeletionSweep();
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        const intent = await db.getSkillUploadIntent(fileId);
        if (intent?.lastCleanupAttemptAt && !intent.claimOwner) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const intent = await db.getSkillUploadIntent(fileId);
      expect(intent?.cleanedAt).toBeInstanceOf(Date);
      expect(intent?.lastCleanupAttemptAt).toBeInstanceOf(Date);
      expect(intent?.claimOwner).toBeUndefined();
      expect(intent?.nextCheckAt).toBeInstanceOf(Date);
      expect(await db.listAbandonedSkillUploadIntents()).toEqual([]);
      expect(deleteFile).toHaveBeenCalledTimes(1);
      expect(logger.error).not.toHaveBeenCalled();
    } finally {
      sweep.stop();
    }
  });

  it('retains a failed S3 deletion and retries it with a new worker instance', async () => {
    const db = createMethods(mongoose);
    const author = new Types.ObjectId();
    const tenantId = 'restart-test';
    const { skill } = await tenantStorage.run({ tenantId }, () =>
      db.createSkill({
        name: 'restart-test',
        description: 'Exercise durable Skill deletion after a worker restart.',
        body: 'Test instructions.',
        author,
        authorName: 'Test',
        tenantId,
      }),
    );
    const fileId = 'restart-file';
    const storageKey = 'r/us-east-2/uploads/restart-test/guide.md';
    await tenantStorage.run({ tenantId }, () =>
      db.upsertSkillFile({
        skillId: skill._id,
        relativePath: 'references/guide.md',
        file_id: fileId,
        filename: 'guide.md',
        filepath: 'https://storage.example.test/restart-test/guide.md',
        storageKey,
        storageRegion: 'us-east-2',
        source: 's3',
        mimeType: 'text/markdown',
        bytes: 10,
        author,
        tenantId,
      }),
    );

    let storageAvailable = false;
    const deleteFile = jest.fn(async () => {
      if (!storageAvailable) throw new Error('temporary S3 outage');
    });
    const makeWorker = () =>
      createSkillDeletionService({
        persistence: { ...db, ...createSkillDeletionPersistenceAdapter(db) },
        loadConfig: async () =>
          ({ skillDeletion: { finalizationEnabled: true } }) as unknown as AppConfig,
        getStrategyFunctions: (source) => (source === 's3' ? { deleteFile } : {}),
        runAsSystem: async (callback) => callback(),
        logger: { error: jest.fn(), warn: jest.fn() },
      });

    const firstWorker = makeWorker();
    const pending = await firstWorker.deleteSkillById(skill._id.toString());
    expect(pending.cleanupComplete).toBe(false);
    expect(await db.getSkillFileByPath(skill._id, 'references/guide.md')).not.toBeNull();
    expect(await db.getSkillDeletion(skill._id.toString())).not.toBeNull();

    // Simulate a fresh process using the same persisted database and provider.
    storageAvailable = true;
    const restartedWorker = makeWorker();
    const sweep = restartedWorker.startSkillDeletionSweep({ sweepIntervalMs: 1_000 });
    try {
      for (let attempt = 0; attempt < 50; attempt++) {
        if ((await mongoose.models.Skill.findById(skill._id)) == null) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(await mongoose.models.Skill.findById(skill._id)).toBeNull();
      expect(await db.getSkillFileByPath(skill._id, 'references/guide.md')).toBeNull();
      expect(deleteFile).toHaveBeenCalledWith(
        expect.objectContaining({ user: expect.objectContaining({ tenantId }) }),
        expect.objectContaining({ storageKey, storageRegion: 'us-east-2', tenantId }),
      );
    } finally {
      sweep.stop();
    }
  });

  it('cleans a multi-page manifest and retries only the failed file with real persistence', async () => {
    const db = createMethods(mongoose);
    const author = new Types.ObjectId();
    const { skill } = await db.createSkill({
      name: 'paged-cleanup',
      description: 'Paged cleanup retry.',
      body: '',
      author,
      authorName: 'Test',
    });
    await mongoose.models.SkillFile.insertMany(
      Array.from({ length: 37 }, (_, index) => ({
        skillId: skill._id,
        file_id: `paged-retry-${index}`,
        relativePath: `${index}.md`,
        filename: `${index}.md`,
        filepath: `uploads/${author}/${index}`,
        source: 's3',
        mimeType: 'text/markdown',
        bytes: 4,
        author,
      })),
    );
    let available = false;
    const deleted = new Map<string, number>();
    const deleteFile = jest.fn(async (_request, file: { file_id?: string; filepath: string }) => {
      const key = file.filepath;
      if (!available && key.endsWith('/23')) throw new Error('temporary provider failure');
      deleted.set(key, (deleted.get(key) ?? 0) + 1);
    });
    const makeService = () =>
      createSkillDeletionService({
        persistence: { ...db, ...createSkillDeletionPersistenceAdapter(db) },
        loadConfig: async () =>
          ({ skillDeletion: { finalizationEnabled: true, batchSize: 5 } }) as unknown as AppConfig,
        getStrategyFunctions: () => ({ deleteFile }),
        runAsSystem: async (callback) => callback(),
        logger: { error: jest.fn(), warn: jest.fn() },
      });
    const first = await makeService().deleteSkillById(skill._id.toString());
    expect(first.cleanupComplete).toBe(false);
    expect(await mongoose.models.SkillFile.countDocuments({ skillId: skill._id })).toBe(1);
    expect(deleted.size).toBe(36);
    available = true;
    expect((await makeService().deleteSkillById(skill._id.toString())).cleanupComplete).toBe(true);
    expect(await mongoose.models.SkillFile.countDocuments({ skillId: skill._id })).toBe(0);
    expect(await mongoose.models.Skill.findById(skill._id)).toBeNull();
    expect(deleted.size).toBe(37);
    expect([...deleted.values()].every((count) => count === 1)).toBe(true);
    expect(deleteFile).toHaveBeenCalledTimes(38);
  });
});
