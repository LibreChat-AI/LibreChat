import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { MongoMemoryServer, MongoMemoryReplSet } from 'mongodb-memory-server';
import { allocateManagedTarget, managedRegistration } from './managed';
import { createResponseScopeModel } from '~/models/responseScope';
import { registerResponseTarget } from './registration';
import { tenantStorage } from '~/config/tenantContext';
import { createAgentChannelMethods } from './channel';
import { responseScopeKeys } from './responseScope';
import { createUserMethods } from './user';
import { createModels } from '~/models';

const engines = ['standalone', 'replica', ...(process.env.FERRETDB_URI ? ['FerretDB'] : [])];
describe.each(engines)('portable canonical channel updates on %s', (engine) => {
  let server: MongoMemoryServer | MongoMemoryReplSet | undefined;
  beforeAll(async () => {
    if (engine === 'replica') server = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    else if (engine === 'standalone') server = await MongoMemoryServer.create();
    createModels(mongoose);
    await mongoose.connect(server?.getUri() ?? process.env.FERRETDB_URI!, {
      dbName: `channel_updates_${randomUUID().replace(/-/g, '')}`,
    });
  }, 60000);
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await mongoose.disconnect();
    await server?.stop();
  });
  describe.each([undefined, 'channel-update-tenant'])('tenant %s', (tenantId) => {
    const scope = (test: () => Promise<void>) => tenantStorage.run({ tenantId }, test);
    async function fixture() {
      const user = await mongoose
        .model('User')
        .create({ provider: 'local', email: `${randomUUID()}@example.test` });
      const owner = { userId: String(user._id), ...(tenantId && { tenantId }) };
      const methods = createAgentChannelMethods(mongoose);
      const input = {
        channelId: randomUUID(),
        createdBy: owner.userId,
        agentId: 'agent',
        type: 'slack' as const,
        status: 'active' as const,
        credentialMode: 'shared' as const,
        revision: 'initial',
        slack: { teamId: 'T1', appId: 'A1', botUserId: 'B1' },
        encryptedBotToken: 'synthetic-original-token',
      };
      await methods.createAgentChannel(input);
      return { owner, methods, input };
    }
    it('advances authority without a caller nonce and opens no session', () =>
      scope(async () => {
        const f = await fixture();
        const sessions = jest.spyOn(mongoose, 'startSession');
        const updated = await f.methods.updateAgentChannel(f.input.channelId, f.owner.userId, {
          credentialMode: 'per_user',
        });
        expect(updated).toMatchObject({ credentialMode: 'per_user' });
        expect(updated!.revision).not.toBe(f.input.revision);
        expect(
          await f.methods.updateAgentChannel(
            f.input.channelId,
            f.owner.userId,
            { status: 'disabled' },
            undefined,
            f.input.revision,
          ),
        ).toBeNull();
        expect(
          await f.methods.updateAgentChannel(f.input.channelId, f.owner.userId, {
            encryptedBotToken: 'same-generation-change',
            revision: updated!.revision,
          }),
        ).toBeNull();
        expect((await f.methods.getAgentChannel(f.input.channelId))!.encryptedBotToken).toBe(
          f.input.encryptedBotToken,
        );
        expect(sessions).not.toHaveBeenCalled();
      }));

    it('keeps revocation available when a private admission registry is full', () =>
      scope(async () => {
        const f = await fixture();
        const disputed = await allocateManagedTarget(mongoose, 'channelRun', tenantId);
        expect(
          await registerResponseTarget(
            mongoose,
            f.owner,
            undefined,
            managedRegistration(disputed),
            { maxPendingTargetsPerScope: 1 },
          ),
        ).toMatchObject({ status: 'registered' });
        const updated = await f.methods.updateAgentChannel(f.input.channelId, f.owner.userId, {
          status: 'disabled',
        });
        expect(updated).toMatchObject({ status: 'disabled' });
        expect(updated!.revision).not.toBe('initial');
        expect(
          await createResponseScopeModel(mongoose)
            .findById(responseScopeKeys(f.owner, '')[0])
            .lean(),
        ).toMatchObject({ pendingCount: 1, pending: [{ target: disputed }] });
      }));

    it('budgets competing credential edits against one exact version', () =>
      scope(async () => {
        const f = await fixture();
        const size = 7 * 1024 * 1024;
        const results = await Promise.allSettled([
          f.methods.updateAgentChannel(f.input.channelId, f.owner.userId, {
            encryptedBotToken: 'b'.repeat(size),
          }),
          f.methods.updateAgentChannel(f.input.channelId, f.owner.userId, {
            encryptedSigningSecret: 's'.repeat(size),
          }),
        ]);
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        const failure = results.find(
          (result) => result.status === 'rejected',
        ) as PromiseRejectedResult;
        expect(failure.reason).toMatchObject({ code: 'document_limit' });
      }));

    it.each(['erase', 'replace'] as const)(
      'cannot edit a retired or replaced physical root: %s',
      (action) =>
        scope(async () => {
          const f = await fixture();
          const collection = mongoose.model('AgentChannel').collection;
          const write = collection.findOneAndUpdate.bind(collection);
          let entered!: () => void;
          let release!: () => void;
          const started = new Promise<void>((resolve) => {
            entered = resolve;
          });
          const gate = new Promise<void>((resolve) => {
            release = resolve;
          });
          jest.spyOn(collection, 'findOneAndUpdate').mockImplementation(async (...args) => {
            if (!Array.isArray(args[1]) && args[1].$set?.revision === 'paused-edit') {
              entered();
              await gate;
            }
            return write(...args);
          });
          const editing = f.methods.updateAgentChannel(f.input.channelId, f.owner.userId, {
            encryptedBotToken: 'synthetic-late-token',
            revision: 'paused-edit',
          });
          let timedOut = false;
          const timeout = setTimeout(() => {
            timedOut = true;
            release();
          }, 5000);
          try {
            await started;
            if (action === 'erase')
              expect(
                await createUserMethods(mongoose).deleteUserById(f.owner.userId),
              ).toMatchObject({ deletedCount: 1 });
            else {
              await collection.deleteOne({ channelId: f.input.channelId });
              await f.methods.createAgentChannel({
                ...f.input,
                encryptedBotToken: 'synthetic-replacement-token',
              });
            }
            expect(timedOut).toBe(false);
          } finally {
            clearTimeout(timeout);
            release();
          }
          expect(await editing).toBeNull();
          const saved = await f.methods.getAgentChannel(f.input.channelId);
          if (action === 'erase') expect(saved).toBeNull();
          else
            expect(saved).toMatchObject({
              encryptedBotToken: 'synthetic-replacement-token',
              revision: 'initial',
            });
        }),
    );

    it('does not replay a private edit when its applied reply is lost', () =>
      scope(async () => {
        const f = await fixture();
        const collection = mongoose.model('AgentChannel').collection;
        const write = collection.findOneAndUpdate.bind(collection);
        let edits = 0;
        jest.spyOn(collection, 'findOneAndUpdate').mockImplementation(async (...args) => {
          const result = await write(...args);
          if (!Array.isArray(args[1]) && args[1].$set?.revision === 'edited') {
            edits++;
            throw new Error('synthetic lost edit reply');
          }
          return result;
        });
        await expect(
          f.methods.updateAgentChannel(f.input.channelId, f.owner.userId, {
            revision: 'edited',
            encryptedBotToken: 'synthetic-edited-token',
          }),
        ).rejects.toThrow('synthetic lost edit reply');
        expect(edits).toBe(1);
        expect(await f.methods.getAgentChannel(f.input.channelId)).toMatchObject({
          revision: 'edited',
          encryptedBotToken: 'synthetic-edited-token',
        });
      }));
  });
});
