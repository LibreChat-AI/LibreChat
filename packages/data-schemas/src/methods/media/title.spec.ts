import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { mediaSubmissionRequestSchema } from 'librechat-data-provider';
import type { MediaMethods, MediaOwnerScope, MediaStoredThread } from '~/types/media';
import { tenantStorage } from '~/config/tenantContext';
import { createMediaTitleMethods } from './title';
import { createMediaMethods } from './index';

describe('durable media title admission', () => {
  let mongo: MongoMemoryServer;
  let media: MediaMethods;
  let scope: MediaOwnerScope;
  let sequence = 0;
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    media = createMediaMethods(mongoose, { ownerExists: async () => true });
    await media.ensureMediaIndexes();
  }, 60_000);
  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  });
  beforeEach(async () => {
    await Promise.all(
      Object.values(mongoose.models).map((model) => model.collection.deleteMany({})),
    );
    scope = { ownerId: new mongoose.Types.ObjectId().toString(), tenantId: null };
  });
  async function stage(
    options: { temporary?: boolean; threadId?: string; balance?: boolean } = {},
  ) {
    const request = mediaSubmissionRequestSchema.parse({
      clientRequestId: `title-${++sequence}`,
      operation: 'image.generate',
      prompt: 'An observatory',
      selection: { connectionId: 'images', modelId: 'image-model', catalogVersion: 'v1' },
      temporary: options.temporary,
      threadId: options.threadId,
    });
    const receipt = await media.stageMediaSubmission({
      scope,
      request,
      maxActiveJobs: 20,
      maxPendingTotal: 100,
      execution: {
        ...request.selection,
        api: 'openrouter.images',
        bindingRevision: 'binding',
        accountingMode: options.balance ? 'balance' : 'none',
      },
    });
    await media.publishMediaSubmission(scope, receipt.jobId, {
      maxRetainers: 4,
      maxTitleChars: 100,
      temporaryRetentionMs: 1000,
    });
    return {
      scope,
      jobId: receipt.jobId,
      threadId: receipt.threadId,
      expectedTitle: request.prompt,
    };
  }

  it('grants one paid invocation under concurrent submission and restart replay', async () => {
    const input = await stage();
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        createMediaTitleMethods(mongoose).claimMediaThreadTitle(input),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await createMediaTitleMethods(mongoose).claimMediaThreadTitle(input)).toBe(false);
    const thread = await mongoose.models.MediaThread.findOne({ threadId: input.threadId })
      .select('titleClaim')
      .lean<Pick<MediaStoredThread, 'titleClaim'>>();
    expect(thread?.titleClaim).toMatchObject({ jobId: input.jobId, claimedAt: expect.any(Date) });
  });

  it('will not admit a title for a generation lacking its required media hold', async () => {
    const input = await stage({ balance: true });
    const titles = createMediaTitleMethods(mongoose);
    expect(await titles.claimMediaThreadTitle(input)).toBe(false);
    await mongoose.models.MediaJob.updateOne(
      { jobId: input.jobId },
      {
        $set: { accounting: { settlementId: 'held-media', phase: 'held' } },
      },
    );
    expect(await titles.claimMediaThreadTitle(input)).toBe(true);
  });

  it('leaves temporary creations and later turns with their existing title', async () => {
    const temporary = await stage({ temporary: true });
    const first = await stage();
    const later = await stage({ threadId: first.threadId });
    const titles = createMediaTitleMethods(mongoose);
    expect(await titles.claimMediaThreadTitle(temporary)).toBe(false);
    expect(await titles.claimMediaThreadTitle(later)).toBe(false);
    expect(await titles.claimMediaThreadTitle(first)).toBe(true);
  });

  it.each(['submitting', 'running', 'ingesting'])(
    'admits the origin title once after generation advances to %s',
    async (phase) => {
      const input = await stage({ balance: true });
      await mongoose.models.MediaJob.updateOne(
        { jobId: input.jobId },
        {
          $set: {
            phase,
            accounting: {
              settlementId: 'generation',
              phase: 'held',
            },
          },
        },
      );
      const titles = createMediaTitleMethods(mongoose);
      expect(await titles.claimMediaThreadTitle(input)).toBe(true);
      expect(await titles.claimMediaThreadTitle(input)).toBe(false);
    },
  );

  it.each(['failed', 'cancelled', 'reconciling', 'requires_attention', 'succeeded'])(
    'does not start a late title for a %s generation',
    async (phase) => {
      const input = await stage();
      await mongoose.models.MediaJob.updateOne({ jobId: input.jobId }, { $set: { phase } });
      expect(await createMediaTitleMethods(mongoose).claimMediaThreadTitle(input)).toBe(false);
    },
  );

  it.each(['renamed', 'retired', 'cancelled'])(
    'declines paid title dispatch once its target is %s',
    async (state) => {
      const input = await stage();
      if (state === 'renamed')
        await mongoose.models.MediaThread.updateOne(
          { threadId: input.threadId },
          { $set: { title: 'User title' } },
        );
      if (state === 'retired')
        await mongoose.models.MediaThread.updateOne(
          { threadId: input.threadId },
          { $set: { status: 'retired' } },
        );
      if (state === 'cancelled')
        await mongoose.models.MediaJob.updateOne(
          { jobId: input.jobId },
          { $set: { cancelRequestedAt: new Date().toISOString() } },
        );
      expect(await createMediaTitleMethods(mongoose).claimMediaThreadTitle(input)).toBe(false);
    },
  );

  it('keeps claims scoped to both owner and tenant', async () => {
    const input = await stage();
    const titles = createMediaTitleMethods(mongoose);
    expect(
      await titles.claimMediaThreadTitle({ ...input, scope: { ...scope, ownerId: 'other' } }),
    ).toBe(false);
    expect(
      await titles.claimMediaThreadTitle({ ...input, scope: { ...scope, tenantId: 'other' } }),
    ).toBe(false);
    await expect(
      tenantStorage.run({ tenantId: 'other' }, () => titles.claimMediaThreadTitle(input)),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(await titles.claimMediaThreadTitle(input)).toBe(true);
  });
});
