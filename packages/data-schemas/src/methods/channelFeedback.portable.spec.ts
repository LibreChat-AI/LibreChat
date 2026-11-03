import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { MongoMemoryServer, MongoMemoryReplSet } from 'mongodb-memory-server';
import type { ChannelReplyMapping, ChannelFeedbackVote } from 'librechat-data-provider';
import type { ChannelFeedbackLedger, ChannelFeedbackEventRecord } from '~/models/channelFeedback';
import { closeResponseScopes, createResponseRetention, responseScopeKeys } from './responseScope';
import { eraseChannelFeedbackForOwner } from './channelFeedbackErasure';
import { recoverFeedbackReceipts } from './channelFeedbackCheckpoint';
import { tenantStorage, runAsSystem } from '~/config/tenantContext';
import { createResponseScopeModel } from '~/models/responseScope';
import { createChannelFeedbackStorage } from './channelFeedback';
import { MAX_BSON_DOCUMENT_BYTES } from '~/utils/bson';
import { createAgentChannelMethods } from './channel';
import { createModels } from '~/models';

const engines = ['standalone', 'replica', ...(process.env.FERRETDB_URI ? ['FerretDB'] : [])];
describe.each(engines)('portable feedback on %s', (engine) => {
  let server: MongoMemoryServer | MongoMemoryReplSet | undefined;
  beforeAll(async () => {
    if (engine === 'replica') server = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    else if (engine === 'standalone') server = await MongoMemoryServer.create();
    createModels(mongoose);
    await mongoose.connect(server?.getUri() ?? process.env.FERRETDB_URI!, {
      dbName: `feedback_${randomUUID().replace(/-/g, '')}`,
    });
  }, 60000);
  beforeEach(async () => {
    await runAsSystem(async () => {
      await Promise.all(
        [
          'ChannelReply',
          'ChannelFeedback',
          'ChannelFeedbackEvent',
          'AgentChannel',
          'ChannelScope',
          'ResponseScope',
          'Message',
        ].map((name) => mongoose.models[name].deleteMany({})),
      );
    });
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await mongoose.disconnect();
    await server?.stop();
  });
  describe.each([undefined, 'feedback-tenant'])('tenant %s', (tenantId) => {
    const scoped = (work: () => Promise<void>) => tenantStorage.run({ tenantId }, work);
    async function fixture() {
      const owner = {
        userId: String(new mongoose.Types.ObjectId()),
        ...(tenantId && { tenantId }),
      };
      const channels = createAgentChannelMethods(mongoose);
      const channelId = randomUUID();
      await channels.createAgentChannel({
        channelId,
        agentId: 'agent',
        createdBy: owner.userId,
        type: 'slack',
        status: 'active',
        credentialMode: 'shared',
        revision: 'one',
        slack: { teamId: 'T', appId: 'A', botUserId: 'B' },
      });
      const responseId = randomUUID();
      const mapping: ChannelReplyMapping = {
        tenantId: tenantId || '_',
        channelId,
        agentId: 'agent',
        channelRevision: 'one',
        teamId: 'T',
        externalMessageKey: 'C:reply',
        runId: randomUUID(),
        responseId,
        messageId: responseId,
        conversationId: randomUUID(),
        principalId: owner.userId,
        traceId: 'trace',
        centralTraceExportEnabled: false,
      };
      const message = await mongoose.models.Message.create({
        tenantId,
        user: owner.userId,
        conversationId: mapping.conversationId,
        messageId: responseId,
        isCreatedByUser: false,
        sender: 'Agent',
        endpoint: 'agents',
        model: 'agent',
        text: 'PRIVATE answer',
      });
      const storage = createChannelFeedbackStorage(mongoose);
      const ledgerInput: ChannelFeedbackLedger = {
        tenantId: mapping.tenantId,
        key: randomUUID(),
        mapping,
        externalUserId: 'U',
        scoreId: randomUUID(),
        votes: [],
        revision: 0,
        rating: null,
        exportStatus: 'sent',
        retryAtMs: 0,
      };
      const input = (id: string = randomUUID(), at = 1): ChannelFeedbackEventRecord => ({
        tenantId: mapping.tenantId,
        channelId,
        eventId: id,
        digest: id,
        ledgerKey: ledgerInput.key,
        mapping,
        rating: 'thumbsUp',
        processed: false,
        event: {
          eventId: id,
          eventTimestampUs: at,
          externalUserId: 'U',
          externalMessageKey: mapping.externalMessageKey,
          reaction: 'thumbsup',
          action: 'added',
        },
      });
      async function apply(receipt: ChannelFeedbackEventRecord, acknowledge = true) {
        return storage.withAuthority(mapping, async (active) => {
          const ledger = await active.ensureChannelFeedback(ledgerInput);
          const vote: ChannelFeedbackVote = {
            eventId: receipt.eventId,
            eventTimestampUs: receipt.event.eventTimestampUs,
            reaction: 'thumbsup',
            externalMessageKey: mapping.externalMessageKey,
            rating: 'thumbsUp',
            active: true,
          };
          const next = {
            ...ledger,
            revision: ledger.revision + 1,
            votes: [vote],
            rating: 'thumbsUp' as const,
          };
          expect(await active.saveChannelFeedback(next, ledger.revision, receipt)).toBe(true);
          if (acknowledge) await active.markChannelFeedbackEvent(receipt);
          return next;
        });
      }
      async function erase() {
        await closeResponseScopes(mongoose, owner);
        await eraseChannelFeedbackForOwner(mongoose, owner);
      }
      return {
        owner,
        channels,
        channelId,
        mapping,
        message,
        storage,
        ledgerInput,
        input,
        apply,
        erase,
      };
    }
    it('publishes all three private roots without sessions or payload-bearing inserts', () =>
      scoped(async () => {
        const f = await fixture();
        const sessions = jest.spyOn(mongoose, 'startSession');
        const inserts = ['ChannelReply', 'ChannelFeedbackEvent', 'ChannelFeedback'].map((name) =>
          jest.spyOn(mongoose.models[name].collection, 'insertOne'),
        );
        await f.storage.putChannelReply(f.mapping);
        const receipt = await f.storage.admitChannelFeedbackEvent(f.input());
        await f.apply(receipt);
        for (const name of ['ChannelReply', 'ChannelFeedbackEvent', 'ChannelFeedback']) {
          const raw = await mongoose.models[name].collection.findOne({
            'source.messageTargetId': String(f.message._id),
          });
          expect(raw?._managed).toMatchObject({ phase: 'published', parentId: String(raw!._id) });
          expect(raw?.source.messageTargetId).toBe(String(f.message._id));
        }
        expect(sessions).not.toHaveBeenCalled();
        for (const insert of inserts) expect(insert).not.toHaveBeenCalled();
        await f.erase();
        for (const name of ['ChannelReply', 'ChannelFeedbackEvent', 'ChannelFeedback'])
          expect(
            await mongoose.models[name].collection.countDocuments({
              'source.messageTargetId': String(f.message._id),
            }),
          ).toBe(0);
      }));
    it.each(['ChannelReply', 'ChannelFeedbackEvent', 'ChannelFeedback'] as const)(
      'fences %s publication before account erasure completes',
      (name) =>
        scoped(async () => {
          const f = await fixture();
          const collection = mongoose.models[name].collection;
          const publish = collection.findOneAndUpdate.bind(collection);
          let entered!: () => void;
          let release!: () => void;
          const started = new Promise<void>((resolve) => {
            entered = resolve;
          });
          const gate = new Promise<void>((resolve) => {
            release = resolve;
          });
          const paused = jest
            .spyOn(collection, 'findOneAndUpdate')
            .mockImplementation(async (...args) => {
              entered();
              await gate;
              return publish(...args);
            });
          const operations = {
            ChannelReply: () => f.storage.putChannelReply(f.mapping),
            ChannelFeedbackEvent: () => f.storage.admitChannelFeedbackEvent(f.input()),
            ChannelFeedback: () => f.storage.ensureChannelFeedback(f.ledgerInput),
          };
          const work = operations[name]();
          const result = work.then(
            () => 'unexpected success',
            () => 'rejected',
          );
          const timer = setTimeout(release, 5000);
          try {
            await started;
            await f.erase();
            release();
            expect(await result).toBe('rejected');
          } finally {
            clearTimeout(timer);
            release();
            paused.mockRestore();
          }
          expect(
            await collection.countDocuments({ 'source.messageTargetId': String(f.message._id) }),
          ).toBe(0);
          expect(
            (await createResponseScopeModel(mongoose)
              .findById(responseScopeKeys(f.owner, '')[0])
              .lean())!.pendingCount,
          ).toBe(0);
        }),
    );
    it('inherits a tightened retention epoch while private publication is paused', () =>
      scoped(async () => {
        const f = await fixture();
        const collection = mongoose.models.ChannelReply.collection;
        const publish = collection.findOneAndUpdate.bind(collection);
        let entered!: () => void;
        let release!: () => void;
        const started = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const paused = jest
          .spyOn(collection, 'findOneAndUpdate')
          .mockImplementation(async (...args) => {
            entered();
            await gate;
            return publish(...args);
          });
        const creating = f.storage.putChannelReply(f.mapping);
        const expiry = new Date(Date.now() + 60000);
        const timer = setTimeout(release, 5000);
        try {
          await started;
          await createResponseRetention(mongoose)(f.owner, f.mapping.conversationId, expiry);
          release();
          await creating;
        } finally {
          clearTimeout(timer);
          release();
          paused.mockRestore();
        }
        const row = await collection.findOne({ 'source.messageTargetId': String(f.message._id) });
        expect(row?.expiredAt).toEqual(expiry);
        expect(row?._managed.expiredAt).toEqual(expiry);
      }));
    it('recovers a lost vote reply before ack and expires only superseded pinned receipts', () =>
      scoped(async () => {
        const f = await fixture();
        const first = await f.storage.admitChannelFeedbackEvent(f.input('first', 1));
        await f.apply(first);
        const second = await f.storage.admitChannelFeedbackEvent(f.input('second', 2));
        const collection = mongoose.models.ChannelFeedback.collection;
        const update = collection.findOneAndUpdate.bind(collection);
        const lost = jest
          .spyOn(collection, 'findOneAndUpdate')
          .mockImplementation(async (...args) => {
            await update(...args);
            throw new Error('Synthetic lost vote reply');
          });
        await expect(f.apply(second)).rejects.toThrow('lost vote reply');
        lost.mockRestore();
        const fresh = createChannelFeedbackStorage(mongoose);
        const pending = await fresh.pendingChannelFeedbackEvents(f.mapping.tenantId, 100);
        const recovered = pending.find((row) => row.eventId === second.eventId)!;
        expect(recovered).toBeDefined();
        await fresh.markChannelFeedbackEvent(recovered);
        const old = await mongoose.models.ChannelFeedbackEvent.collection.findOne({
          eventId: first.eventId,
          channelId: f.channelId,
        });
        const current = await mongoose.models.ChannelFeedbackEvent.collection.findOne({
          eventId: second.eventId,
          channelId: f.channelId,
        });
        expect(old?.receiptExpiresAt).toBeInstanceOf(Date);
        expect(current).toMatchObject({ processed: true });
        expect(current).not.toHaveProperty('receiptExpiresAt');
        const expiry = old!.receiptExpiresAt;
        await fresh.markChannelFeedbackEvent(first);
        expect(
          (await mongoose.models.ChannelFeedbackEvent.collection.findOne({ _id: old!._id }))!
            .receiptExpiresAt,
        ).toEqual(expiry);
      }));
    it('refuses to drop or rewind a canonical vote slot', () =>
      scoped(async () => {
        const f = await fixture();
        const first = await f.storage.admitChannelFeedbackEvent(f.input('first', 2));
        await f.apply(first);
        const ledger = (await f.storage.getChannelFeedback(f.mapping.tenantId, f.ledgerInput.key))!;
        const older = await f.storage.admitChannelFeedbackEvent(f.input('older', 1));
        await expect(
          f.storage.saveChannelFeedback(
            { ...ledger, votes: [], revision: ledger.revision + 1 },
            ledger.revision,
            older,
          ),
        ).rejects.toHaveProperty('name', 'ChannelFeedbackAuthorityError');
        expect(
          (await f.storage.getChannelFeedback(f.mapping.tenantId, f.ledgerInput.key))!.votes,
        ).toEqual(ledger.votes);
      }));
    it.each(['Message', 'AgentChannel', 'ChannelFeedback', 'ChannelFeedbackEvent'] as const)(
      'cannot adopt a replacement %s with the same logical identity',
      (name) =>
        scoped(async () => {
          const f = await fixture();
          await f.storage.putChannelReply(f.mapping);
          const receipt = await f.storage.admitChannelFeedbackEvent(f.input());
          await f.apply(receipt, false);
          const collection = mongoose.models[name].collection;
          const filters = {
            Message: { _id: f.message._id },
            AgentChannel: { channelId: f.channelId },
            ChannelFeedback: { key: f.ledgerInput.key },
            ChannelFeedbackEvent: { channelId: f.channelId, eventId: receipt.eventId },
          };
          const filter = filters[name];
          const row = await collection.findOne(filter);
          if (!row) throw new Error('Missing fixture target');
          const id = new mongoose.Types.ObjectId();
          await collection.deleteOne({ _id: row._id });
          await collection.insertOne({
            ...row,
            _id: id,
            ...(row._managed && {
              _managed: { ...row._managed, parentId: String(id), incarnation: randomUUID() },
            }),
          });
          await expect(f.storage.markChannelFeedbackEvent(receipt)).rejects.toHaveProperty(
            'name',
            'ChannelFeedbackAuthorityError',
          );
          if (name === 'ChannelFeedbackEvent')
            expect((await collection.findOne({ _id: id }))!.processed).toBe(false);
        }),
    );
    it('erases feedback only after canonical channel closure', () =>
      scoped(async () => {
        const f = await fixture();
        await f.storage.putChannelReply(f.mapping);
        const receipt = await f.storage.admitChannelFeedbackEvent(f.input());
        await f.apply(receipt);
        expect(await f.channels.deleteAgentChannel(f.channelId, f.owner.userId)).toEqual({
          status: 'deleted',
        });
        expect(await f.storage.isAuthorityCurrent(f.mapping)).toBe(false);
        for (const name of ['ChannelReply', 'ChannelFeedbackEvent', 'ChannelFeedback'])
          expect(
            await mongoose.models[name].collection.countDocuments({
              'source.messageTargetId': String(f.message._id),
            }),
          ).toBe(0);
      }));
    it('cannot expire a newer current receipt from a paused old checkpoint', () =>
      scoped(async () => {
        const f = await fixture();
        const first = await f.storage.admitChannelFeedbackEvent(f.input('first', 1));
        await f.apply(first);
        const second = await f.storage.admitChannelFeedbackEvent(f.input('second', 2));
        const ledgers = mongoose.models.ChannelFeedback.collection;
        const write = ledgers.findOneAndUpdate.bind(ledgers);
        const lost = jest.spyOn(ledgers, 'findOneAndUpdate').mockImplementation(async (...args) => {
          await write(...args);
          throw new Error('Synthetic lost reply');
        });
        await expect(f.apply(second)).rejects.toThrow('lost reply');
        lost.mockRestore();
        await f.storage.markChannelFeedbackEvent(second);
        const checkpoint = (await f.storage.getChannelFeedback(
          f.mapping.tenantId,
          f.ledgerInput.key,
        ))!;
        const events = mongoose.models.ChannelFeedbackEvent.collection;
        const update = events.updateOne.bind(events);
        let entered!: () => void;
        let release!: () => void;
        let stopped = false;
        const started = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const paused = jest.spyOn(events, 'updateOne').mockImplementation(async (...args) => {
          if (
            !stopped &&
            args[0].eventId === first.eventId &&
            !Array.isArray(args[1]) &&
            args[1].$min?.receiptExpiresAt
          ) {
            stopped = true;
            entered();
            await gate;
          }
          return update(...args);
        });
        const maintaining = recoverFeedbackReceipts(mongoose, f.mapping.tenantId, 100, checkpoint);
        const outcome = maintaining.then(
          () => 'done',
          () => 'failed',
        );
        const timer = setTimeout(release, 5000);
        try {
          await started;
          const latest = await f.storage.admitChannelFeedbackEvent(f.input('latest', 3));
          await f.apply(latest);
          release();
          expect(await outcome).toBe('done');
          const current = await events.findOne({ eventId: latest.eventId, channelId: f.channelId });
          expect(current).toMatchObject({ processed: true });
          expect(current).not.toHaveProperty('receiptExpiresAt');
          expect(
            (await f.storage.getChannelFeedback(f.mapping.tenantId, f.ledgerInput.key))!.votes[0]
              .eventId,
          ).toBe(latest.eventId);
        } finally {
          clearTimeout(timer);
          release();
          paused.mockRestore();
        }
      }));
    it('rotates bounded recovery past current pinned receipts after a crash', () =>
      scoped(async () => {
        const f = await fixture();
        for (let index = 0; index < 2; index++) {
          f.ledgerInput.key = randomUUID();
          f.ledgerInput.scoreId = randomUUID();
          await f.apply(await f.storage.admitChannelFeedbackEvent(f.input(`pinned-${index}`, 1)));
        }
        f.ledgerInput.key = randomUUID();
        f.ledgerInput.scoreId = randomUUID();
        const obsolete = await f.storage.admitChannelFeedbackEvent(f.input('obsolete', 1));
        await f.apply(obsolete);
        const next = await f.storage.admitChannelFeedbackEvent(f.input('next', 2));
        const collection = mongoose.models.ChannelFeedback.collection;
        const write = collection.findOneAndUpdate.bind(collection);
        const lost = jest
          .spyOn(collection, 'findOneAndUpdate')
          .mockImplementation(async (...args) => {
            await write(...args);
            throw new Error('Synthetic lost reply');
          });
        await expect(f.apply(next)).rejects.toThrow('lost reply');
        lost.mockRestore();
        for (let index = 0; index < 4; index++)
          await f.storage.pendingChannelFeedbackEvents(f.mapping.tenantId, 1);
        const row = await mongoose.models.ChannelFeedbackEvent.collection.findOne({
          eventId: obsolete.eventId,
          channelId: f.channelId,
        });
        expect(row?.receiptExpiresAt).toBeInstanceOf(Date);
        for (let index = 0; index < 2; index++)
          expect(
            await mongoose.models.ChannelFeedbackEvent.collection.findOne({
              eventId: `pinned-${index}`,
              channelId: f.channelId,
            }),
          ).not.toHaveProperty('receiptExpiresAt');
      }));
    it('includes retained unknown nested fields in the ledger write budget', () =>
      scoped(async () => {
        const f = await fixture();
        const ledger = await f.storage.ensureChannelFeedback(f.ledgerInput);
        const collection = mongoose.models.ChannelFeedback.collection;
        const stored = await collection.findOne({ key: ledger.key });
        if (!stored) throw new Error('Missing fixture ledger');
        const length =
          MAX_BSON_DOCUMENT_BYTES - mongoose.mongo.BSON.calculateObjectSize(stored) - 32768;
        await collection.updateOne(
          { _id: stored._id },
          { $set: { 'mapping.pluginPayload': 'x'.repeat(length) } },
        );
        const event = await f.storage.admitChannelFeedbackEvent(f.input());
        await expect(f.apply(event)).rejects.toHaveProperty('code', 'document_limit');
        const unchanged = await collection.findOne({ _id: stored._id });
        expect(unchanged!.revision).toBe(0);
        expect(unchanged!.mapping.pluginPayload.length).toBe(length);
      }));
    it('enforces persisted BSON budget without leaving a private allocation', () =>
      scoped(async () => {
        const f = await fixture();
        await expect(
          f.storage.putChannelReply({ ...f.mapping, traceId: 'x'.repeat(MAX_BSON_DOCUMENT_BYTES) }),
        ).rejects.toHaveProperty('code', 'document_limit');
        expect(
          await mongoose.models.ChannelReply.collection.countDocuments({
            'source.messageTargetId': String(f.message._id),
          }),
        ).toBe(0);
      }));
  });
});
