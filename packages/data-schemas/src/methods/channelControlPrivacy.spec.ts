import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { MongoMemoryServer, MongoMemoryReplSet } from 'mongodb-memory-server';
import { registerResponseTarget, settleRedactedChannelControlTarget } from './registration';
import { isRedactedCreatorControl, redactCreatorControl } from './channelControlPrivacy';
import { createResponseOwnerErasureMethods } from './responseErasure';
import { eraseChannelPersistenceForUser } from './channelErasure';
import { createChannelIdentityStorage } from './channelIdentity';
import { createManagedMessageId } from '~/utils/managed';
import { createChannelRunStorage } from './channelRun';
import { tenantStorage } from '~/config/tenantContext';
import { createAgentChannelMethods } from './channel';
import { channelRunFence } from './channelRunWrite';
import { closeAgentChannel } from './channelScope';
import { createResponseStorage } from './response';
import { managedRegistration } from './managed';
import { createModels } from '~/models';

const engines = ['standalone', 'replica', ...(process.env.FERRETDB_URI ? ['FerretDB'] : [])];
describe.each(engines)('creator control privacy on %s', (engine) => {
  let server: MongoMemoryServer | MongoMemoryReplSet | undefined;
  beforeAll(async () => {
    if (engine === 'replica') server = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    else if (engine === 'standalone') server = await MongoMemoryServer.create();
    createModels(mongoose);
    await mongoose.connect(server?.getUri() ?? process.env.FERRETDB_URI!, {
      dbName: `control_privacy_${randomUUID().replace(/-/g, '')}`,
    });
  }, 60000);
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await mongoose.disconnect();
    await server?.stop();
  });
  describe.each([undefined, 'privacy-tenant'])('tenant %s', (tenantId) => {
    const scoped = (work: () => Promise<void>) => tenantStorage.run({ tenantId }, work);
    async function fixture(shared = false, creatorId = String(new mongoose.Types.ObjectId())) {
      const ownerId = shared ? creatorId : String(new mongoose.Types.ObjectId());
      const creator = { userId: creatorId, ...(tenantId && { tenantId }) };
      const channelId = randomUUID();
      await createAgentChannelMethods(mongoose).createAgentChannel({
        channelId,
        createdBy: creatorId,
        agentId: 'agent',
        type: 'slack',
        status: 'active',
        credentialMode: shared ? 'shared' : 'per_user',
        revision: 'one',
        slack: { teamId: 'T', appId: 'A', botUserId: 'B' },
        encryptedBotToken: 'PRIVATE-BOT',
        encryptedSigningSecret: 'PRIVATE-SIGNING',
      });
      const linkId = randomUUID();
      const input = {
        tenantId: tenantId || '_',
        channelId,
        agentId: 'agent',
        principal: {
          userId: ownerId,
          channelRevision: 'one',
          ...(!shared && { linkId, linkRevision: 'one' }),
        },
        admission: {
          eventId: 'event',
          externalChannelId: 'C',
          externalThreadKey: 'PRIVATE-THREAD',
          externalMessageKey: 'C:1',
          actor: { teamId: 'T', appId: 'A', externalUserId: 'PRIVATE-ACTOR' },
          input: 'PRIVATE-PROMPT',
        },
      };
      if (!shared)
        await createChannelIdentityStorage(mongoose).saveChannelIdentity(
          {
            tenantId: input.tenantId,
            linkId,
            revision: 'one',
            state: 'active',
            userId: ownerId,
            ticketHash: randomUUID(),
            ticketExpiresAtMs: Date.now() + 60000,
            expiresAtMs: Date.now() + 600000,
            identity: {
              tenantId: input.tenantId,
              channelId,
              channelRevision: 'one',
              agentId: 'agent',
              teamId: 'T',
              externalUserId: input.admission.actor.externalUserId,
            },
          },
          null,
        );
      const storage = createChannelRunStorage(mongoose);
      const { run } = await storage.admit(input, 100);
      const target = run.publication!.control;
      const controlId = new mongoose.Types.ObjectId(target.id);
      const channelTarget = run.publication!.channel.target;
      const prepare = () =>
        createResponseOwnerErasureMethods(mongoose).prepareUserResponseErasure(creator);
      const erase = async () => {
        await prepare();
        await eraseChannelPersistenceForUser(mongoose, creator);
      };
      const close = () =>
        closeAgentChannel(
          mongoose,
          {
            tenantId,
            channelId,
            createdBy: creatorId,
            id: channelTarget.id,
            incarnation: channelTarget.incarnation,
          },
          true,
        );
      const register = () =>
        registerResponseTarget(mongoose, creator, undefined, managedRegistration(target));
      return {
        storage,
        input,
        run,
        creator,
        ownerId,
        target,
        controlId,
        channelTarget,
        prepare,
        erase,
        close,
        register,
      };
    }
    const controls = () => mongoose.models.ChannelLane.collection;
    it('erases all private extensions and releases only the creator control ticket while another account executes', () =>
      scoped(async () => {
        const f = await fixture();
        await f.storage.claim(f.input.tenantId, f.input.channelId, 'worker', 101, 1000);
        await f.storage.observeThreadStop(f.input, 102, 102);
        const before = await controls().findOne({ _id: f.controlId });
        await f.register();
        await controls().updateOne(
          { _id: f.controlId },
          {
            $set: {
              privateExtension: 'PRIVATE-EXTENSION',
              'assignment.extension': 'PRIVATE-GRANT',
              'assignment.run.target.extension': 'PRIVATE-TARGET',
              'stop.extension': 'PRIVATE-STOP',
              '_managed.extension': 'PRIVATE-METADATA',
              conversationId: 'PRIVATE-CURSOR',
            },
          },
        );
        await f.erase();
        const after = await controls().findOne({ _id: f.controlId });
        expect(after!.assignment).toEqual(before!.assignment);
        expect(after!.stop).toEqual(before!.stop);
        expect(after!.revision).toBeGreaterThan(before!.revision);
        expect(JSON.stringify(after)).not.toContain('PRIVATE-');
        expect(await isRedactedCreatorControl(mongoose, f.creator, f.target)).toBe(true);
        await createResponseOwnerErasureMethods(mongoose).assertUserStorageErased(f.creator);
        expect(
          await mongoose.models.ChannelRun.collection.findOne({ runId: f.run.runId }),
        ).toMatchObject({
          principal: { userId: f.ownerId },
          admission: { input: 'PRIVATE-PROMPT' },
        });
      }));
    it('rejects schema-plugin payload and verifies the stored result after replacement', () =>
      scoped(async () => {
        const f = await fixture();
        await f.close();
        const model = mongoose.models.ChannelLane;
        const collection = controls();
        const replace = collection.replaceOne.bind(collection);
        model.schema.add({ privacyPluginField: { type: String, default: 'PRIVATE-PLUGIN' } });
        const spy = jest.spyOn(collection, 'replaceOne').mockImplementation(async (...args) => {
          const result = await replace(...args);
          await collection.updateOne(
            { _id: f.controlId },
            { $set: { privacyPluginField: 'PRIVATE-PLUGIN' } },
          );
          return result;
        });
        try {
          await collection.updateOne(
            { _id: f.controlId },
            { $set: { privacyPluginField: 'PRIVATE-PLUGIN' } },
          );
          expect(await isRedactedCreatorControl(mongoose, f.creator, f.target)).toBe(false);
          await expect(redactCreatorControl(mongoose, f.creator, f.target)).rejects.toThrow(
            'payload erasure is pending',
          );
          expect(await isRedactedCreatorControl(mongoose, f.creator, f.target)).toBe(false);
        } finally {
          spy.mockRestore();
          model.schema.remove('privacyPluginField');
        }
        await redactCreatorControl(mongoose, f.creator, f.target);
        expect(await isRedactedCreatorControl(mongoose, f.creator, f.target)).toBe(true);
      }));
    it('does not acknowledge extension payload and recovers a lost applied scrub reply without replay', () =>
      scoped(async () => {
        const f = await fixture();
        await f.register();
        await f.close();
        await f.prepare();
        await controls().updateOne(
          { _id: f.controlId },
          { $set: { privateExtension: 'PRIVATE-EXTENSION' } },
        );
        expect(
          await settleRedactedChannelControlTarget(
            mongoose,
            f.creator,
            managedRegistration(f.target),
          ),
        ).toBe(false);
        const collection = controls();
        const replace = collection.replaceOne.bind(collection);
        let calls = 0;
        const spy = jest.spyOn(collection, 'replaceOne').mockImplementation(async (...args) => {
          calls++;
          await replace(...args);
          throw new Error('synthetic lost scrub acknowledgment');
        });
        await expect(redactCreatorControl(mongoose, f.creator, f.target)).rejects.toThrow(
          'synthetic lost scrub acknowledgment',
        );
        expect(calls).toBe(1);
        spy.mockRestore();
        await redactCreatorControl(mongoose, f.creator, f.target);
        expect(
          await settleRedactedChannelControlTarget(
            mongoose,
            f.creator,
            managedRegistration(f.target),
          ),
        ).toBe(true);
        expect(await controls().findOne({ _id: f.controlId })).not.toHaveProperty(
          'privateExtension',
        );
      }));
    it('preserves a tighter retention bound that lands before the metadata replacement', () =>
      scoped(async () => {
        const f = await fixture();
        await f.close();
        await controls().updateOne(
          { _id: f.controlId },
          { $set: { privateExtension: 'PRIVATE-EXTENSION' } },
        );
        const collection = controls();
        const replace = collection.replaceOne.bind(collection);
        const expiredAt = new Date(Date.now() + 60000);
        let raced = false;
        jest.spyOn(collection, 'replaceOne').mockImplementation(async (...args) => {
          if (!raced) {
            raced = true;
            await collection.updateOne(
              { _id: f.controlId },
              { $min: { '_managed.expiredAt': expiredAt } },
            );
          }
          return replace(...args);
        });
        await redactCreatorControl(mongoose, f.creator, f.target);
        const after = await collection.findOne({ _id: f.controlId });
        expect(after!._managed.expiredAt).toEqual(expiredAt);
        expect(after).not.toHaveProperty('privateExtension');
      }));
    it('preserves a grant acknowledged while the scrub replacement is paused', () =>
      scoped(async () => {
        const f = await fixture();
        await f.register();
        await controls().updateOne(
          { _id: f.controlId },
          { $set: { privateExtension: 'PRIVATE-EXTENSION' } },
        );
        let grantEntered!: () => void;
        let releaseGrant!: () => void;
        let scrubEntered!: () => void;
        let releaseScrub!: () => void;
        const atGrant = new Promise<void>((resolve) => {
          grantEntered = resolve;
        });
        const grantGate = new Promise<void>((resolve) => {
          releaseGrant = resolve;
        });
        const atScrub = new Promise<void>((resolve) => {
          scrubEntered = resolve;
        });
        const scrubGate = new Promise<void>((resolve) => {
          releaseScrub = resolve;
        });
        const runs = mongoose.models.ChannelRun.collection;
        const lease = runs.findOneAndUpdate.bind(runs);
        const collection = controls();
        const replace = collection.replaceOne.bind(collection);
        let pausedGrant = false;
        let pausedScrub = false;
        const grantSpy = jest
          .spyOn(runs, 'findOneAndUpdate')
          .mockImplementation(async (...args) => {
            if (!Array.isArray(args[1]) && args[1].$set?.leaseGrantId && !pausedGrant) {
              pausedGrant = true;
              grantEntered();
              await grantGate;
            }
            return lease(...args);
          });
        const scrubSpy = jest
          .spyOn(collection, 'replaceOne')
          .mockImplementation(async (...args) => {
            if (!pausedScrub) {
              pausedScrub = true;
              scrubEntered();
              await scrubGate;
            }
            return replace(...args);
          });
        const claiming = f.storage.claim(
          f.input.tenantId,
          f.input.channelId,
          'paused-worker',
          101,
          1000,
        );
        const timeout = setTimeout(() => {
          releaseGrant();
          releaseScrub();
        }, 10000);
        try {
          await atGrant;
          const erasing = f.erase();
          await atScrub;
          releaseGrant();
          expect(await claiming).toMatchObject({ runId: f.run.runId, leaseOwner: 'paused-worker' });
          const granted = await collection.findOne({ _id: f.controlId });
          expect(granted!.assignment.phase).toBe('active');
          releaseScrub();
          await erasing;
          const after = await collection.findOne({ _id: f.controlId });
          expect(after!.assignment).toEqual(granted!.assignment);
          expect(after!.revision).toBeGreaterThan(granted!.revision);
          expect(after).not.toHaveProperty('privateExtension');
          await createResponseOwnerErasureMethods(mongoose).assertUserStorageErased(f.creator);
        } finally {
          clearTimeout(timeout);
          releaseGrant();
          releaseScrub();
          grantSpy.mockRestore();
          scrubSpy.mockRestore();
        }
      }));
    it.each(['live', 'hidden', 'foreign', 'wrong-role'] as const)(
      'rejects %s parent or role authority',
      (failure) =>
        scoped(async () => {
          const f = await fixture();
          if (failure !== 'live') await f.close();
          if (failure === 'hidden')
            await mongoose.models.AgentChannel.collection.updateOne(
              { _id: new mongoose.Types.ObjectId(f.channelTarget.id) },
              { $set: { '_managed.phase': 'retired' } },
            );
          if (failure === 'wrong-role')
            await controls().updateOne(
              { _id: f.controlId },
              { $set: { '_managed.scopeKeys': [] } },
            );
          const owner =
            failure === 'foreign'
              ? { ...f.creator, userId: String(new mongoose.Types.ObjectId()) }
              : f.creator;
          await controls().updateOne(
            { _id: f.controlId },
            { $set: { privateExtension: 'PRIVATE-EXTENSION' } },
          );
          expect(await isRedactedCreatorControl(mongoose, owner, f.target)).toBe(false);
          await expect(redactCreatorControl(mongoose, owner, f.target)).rejects.toThrow(
            'authority unavailable',
          );
          expect(await controls().findOne({ _id: f.controlId })).toHaveProperty('privateExtension');
        }),
    );
    it('accepts true captured-parent absence without adopting a replacement parent', () =>
      scoped(async () => {
        const f = await fixture();
        const parent = await mongoose.models.AgentChannel.collection.findOne({
          _id: new mongoose.Types.ObjectId(f.channelTarget.id),
        });
        await mongoose.models.AgentChannel.collection.updateOne(
          { _id: parent!._id },
          { $set: { '_managed.incarnation': randomUUID() } },
        );
        await controls().updateOne(
          { _id: f.controlId },
          { $set: { privateExtension: 'PRIVATE-EXTENSION' } },
        );
        await redactCreatorControl(mongoose, f.creator, f.target);
        expect(await isRedactedCreatorControl(mongoose, f.creator, f.target)).toBe(true);
        expect(
          await mongoose.models.AgentChannel.collection.findOne({ _id: parent!._id }),
        ).toMatchObject({ status: 'active', encryptedBotToken: 'PRIVATE-BOT' });
        expect(await f.close()).toBeNull();
      }));
    it('closes every creator channel before the first identity cascade can fail', () =>
      scoped(async () => {
        const f = await fixture();
        const second = await fixture(false, f.creator.userId);
        const collection = mongoose.models.ChannelIdentity.collection;
        const update = collection.updateOne.bind(collection);
        jest.spyOn(collection, 'updateOne').mockImplementation(async (...args) => {
          if (!Array.isArray(args[1]) && args[1].$set?.['_managed.phase'] === 'retired')
            throw new Error('synthetic child cleanup failure');
          return update(...args);
        });
        await expect(f.erase()).rejects.toThrow('synthetic child cleanup failure');
        for (const value of [f, second]) {
          const parent = await mongoose.models.AgentChannel.collection.findOne({
            channelId: value.input.channelId,
          });
          expect(parent).toMatchObject({ status: 'deleting' });
          expect(parent).not.toHaveProperty('encryptedBotToken');
          expect(parent).not.toHaveProperty('encryptedSigningSecret');
        }
      }));
    it('redacts all creator credentials even when its own canonical provider drain is pending', () =>
      scoped(async () => {
        const f = await fixture(true);
        const second = await fixture(true, f.creator.userId);
        const claimed = (await f.storage.claim(
          f.input.tenantId,
          f.input.channelId,
          'worker',
          101,
          1000,
        ))!;
        const capability = channelRunFence(claimed);
        await f.storage.prepareExecution(f.input.tenantId, capability, 102);
        const run = await f.storage.attachResponseCredential(
          f.input.tenantId,
          capability,
          { apiKeyId: 'key', encryptedApiKey: 'synthetic' },
          103,
        );
        const responses = createResponseStorage(mongoose);
        const reserved = await responses.reserve({
          ...(tenantId && { tenantId }),
          userId: f.ownerId,
          agentId: 'agent',
          sourceKeyId: 'key',
          responseId: createManagedMessageId(),
          requestKey: `channel:${run.runId}`,
          fingerprint: 'accepted',
          conversationId: run.execution!.conversationId,
          parentMessageId: run.execution!.parentMessageId,
          requestJSON: JSON.stringify({
            model: 'agent',
            input: f.input.admission.input,
            background: true,
            store: true,
          }),
        });
        if (!reserved.ok) throw new Error('Reservation failed');
        await f.storage.bindResponse(f.input.tenantId, capability, reserved.record.responseId, 104);
        const binding = { generationCreatedAt: Date.now(), providerExecutionId: randomUUID() };
        const enrolled = await responses.enrollExecution(reserved.record, binding, '{}');
        if (!enrolled.ok || !(await responses.bindExecution(enrolled.record, binding)))
          throw new Error('Enrollment failed');
        await expect(f.erase()).rejects.toMatchObject({ code: 'response_erasure_pending' });
        for (const value of [f, second]) {
          const parent = await mongoose.models.AgentChannel.collection.findOne({
            channelId: value.input.channelId,
          });
          expect(parent).toMatchObject({ status: 'deleting' });
          expect(parent).not.toHaveProperty('encryptedBotToken');
          expect(parent).not.toHaveProperty('encryptedSigningSecret');
        }
        expect(
          await mongoose.models.ChannelRun.collection.findOne({ runId: f.run.runId }),
        ).toMatchObject({ _managed: { phase: 'published' } });
      }));
  });
});
