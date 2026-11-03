import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { MongoMemoryServer, MongoMemoryReplSet } from 'mongodb-memory-server';
import { closeResponseScopes, responseScopeKeys } from './responseScope';
import { createResponseScopeModel } from '~/models/responseScope';
import { createChannelLaneRootStorage } from './channelLaneRoot';
import { createChannelIdentityStorage } from './channelIdentity';
import { tenantStorage } from '~/config/tenantContext';
import { createAgentChannelMethods } from './channel';
import { retireManagedAllocation } from './managed';
import { createModels } from '~/models';

const engines = ['standalone', 'replica', ...(process.env.FERRETDB_URI ? ['FerretDB'] : [])];
describe.each(engines)('registered lane roots on %s', (engine) => {
  let server: MongoMemoryServer | MongoMemoryReplSet | undefined;
  beforeAll(async () => {
    if (engine === 'replica') server = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    else if (engine === 'standalone') server = await MongoMemoryServer.create();
    createModels(mongoose);
    await mongoose.connect(server?.getUri() ?? process.env.FERRETDB_URI!, {
      dbName: `lane_roots_${randomUUID().replace(/-/g, '')}`,
    });
  }, 60000);
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await mongoose.disconnect();
    await server?.stop();
  });
  describe.each([undefined, 'lane-tenant'])('tenant %s', (tenantId) => {
    const scoped = (test: () => Promise<void>) => tenantStorage.run({ tenantId }, test);
    async function fixture(mode: 'shared' | 'per_user' = 'per_user') {
      const creator = String(new mongoose.Types.ObjectId());
      const owner = String(new mongoose.Types.ObjectId());
      const channelId = randomUUID();
      const channels = createAgentChannelMethods(mongoose);
      await channels.createAgentChannel({
        channelId,
        createdBy: creator,
        agentId: 'agent',
        type: 'slack',
        status: 'active',
        credentialMode: mode,
        revision: 'channel-rev',
        slack: { teamId: 'T1', appId: 'A1', botUserId: 'B1' },
      });
      const scope = {
        tenantId: tenantId || '_',
        channelId,
        agentId: 'agent',
        principal: {
          userId: owner,
          channelRevision: 'channel-rev',
          linkId: randomUUID(),
          linkRevision: 'link-rev',
        },
        admission: {
          actor: { teamId: 'T1', appId: 'A1', externalUserId: 'PRIVATE-ACTOR' },
          externalChannelId: 'C1',
          externalThreadKey: 'PRIVATE-THREAD',
        },
      };
      const identities = createChannelIdentityStorage(mongoose);
      if (mode === 'per_user')
        await identities.saveChannelIdentity(
          {
            tenantId: scope.tenantId,
            linkId: scope.principal.linkId,
            revision: scope.principal.linkRevision,
            state: 'active',
            userId: owner,
            ticketHash: randomUUID(),
            ticketExpiresAtMs: Date.now() + 60_000,
            expiresAtMs: Date.now() + 600_000,
            identity: {
              tenantId: scope.tenantId,
              channelId,
              channelRevision: scope.principal.channelRevision,
              agentId: scope.agentId,
              teamId: 'T1',
              externalUserId: scope.admission.actor.externalUserId,
            },
          },
          null,
        );
      return {
        creator,
        owner,
        channels,
        identities,
        scope,
        storage: createChannelLaneRootStorage(mongoose),
      };
    }
    it('converges concurrent candidates without sessions and keeps controls free of private continuation data', () =>
      scoped(async () => {
        const f = await fixture();
        const sessions = jest.spyOn(mongoose, 'startSession');
        const controls = await Promise.all(
          Array.from({ length: 6 }, () =>
            f.storage.acquire(f.scope, { kind: 'control' }, Date.now()),
          ),
        );
        expect(new Set(controls.map((row) => row.target.id)).size).toBe(1);
        const control = controls[0];
        const annotated = {
          ...f.scope,
          admission: {
            ...f.scope.admission,
            actor: { ...f.scope.admission.actor, label: 'incidental ingress label' },
          },
        };
        expect(
          (await f.storage.acquire(annotated, { kind: 'control' }, Date.now())).target,
        ).toEqual(control.target);

        const principals = await Promise.all(
          Array.from({ length: 6 }, () =>
            f.storage.acquire(
              f.scope,
              { kind: 'principal', controlTarget: control.target },
              Date.now(),
            ),
          ),
        );
        expect(new Set(principals.map((row) => row.target.id)).size).toBe(1);
        const raw = await mongoose
          .model('ChannelLane')
          .collection.findOne({ _id: new mongoose.Types.ObjectId(control.target.id) });
        for (const field of [
          'userId',
          'conversationId',
          'responseId',
          'nextSequence',
          'publisher',
          'identityRef',
          'controlTarget',
        ])
          expect(raw).not.toHaveProperty(field);
        for (const value of [f.owner, f.creator, 'PRIVATE-ACTOR', 'PRIVATE-THREAD'])
          expect(JSON.stringify(raw)).not.toContain(value);
        expect(principals[0].record).toMatchObject({
          kind: 'principal',
          userId: f.owner,
          nextSequence: 0,
          publishedThrough: 0,
          controlTarget: control.target,
        });
        expect(
          await mongoose.model('ChannelLane').countDocuments({ channelId: f.scope.channelId }),
        ).toBe(2);
        expect(sessions).not.toHaveBeenCalled();
      }));

    it('rejects shared-mode callers who are not the canonical owner', () =>
      scoped(async () => {
        const f = await fixture('shared');
        const shared = {
          ...f.scope,
          principal: { userId: f.owner, channelRevision: 'channel-rev' },
        };
        await expect(
          f.storage.acquire(shared, { kind: 'control' }, Date.now()),
        ).rejects.toMatchObject({ code: 'invalid_transition' });
        expect(
          (
            await f.storage.acquire(
              { ...shared, principal: { ...shared.principal, userId: f.creator } },
              { kind: 'control' },
              Date.now(),
            )
          ).record.kind,
        ).toBe('control');
      }));

    it('refuses to adopt a replacement control target for an already bound principal lane', () =>
      scoped(async () => {
        const f = await fixture();
        const control = await f.storage.acquire(f.scope, { kind: 'control' }, Date.now());
        const principal = await f.storage.acquire(
          f.scope,
          { kind: 'principal', controlTarget: control.target },
          Date.now(),
        );
        await mongoose.model('ChannelLane').deleteOne({ _id: control.target.id });
        const replacement = await f.storage.acquire(f.scope, { kind: 'control' }, Date.now());
        expect(replacement.target.id).not.toBe(control.target.id);
        await expect(
          f.storage.acquire(
            f.scope,
            { kind: 'principal', controlTarget: replacement.target },
            Date.now(),
          ),
        ).rejects.toMatchObject({ code: 'invalid_transition' });
        expect(
          await mongoose.model('ChannelLane').findById(principal.target.id).lean(),
        ).toMatchObject({ controlTarget: control.target });
      }));

    it('cannot publish a private lane after its registered allocation is fenced', () =>
      scoped(async () => {
        const f = await fixture();
        const control = await f.storage.acquire(f.scope, { kind: 'control' }, Date.now());
        const collection = mongoose.model('ChannelLane').collection;
        const write = collection.updateOne.bind(collection);
        let entered!: () => void;
        let release!: () => void;
        const started = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        jest.spyOn(collection, 'updateOne').mockImplementation(async (...args) => {
          if (!Array.isArray(args[1]) && args[1].$set?.kind === 'principal') {
            entered();
            await gate;
          }
          return write(...args);
        });
        const publishing = f.storage
          .acquire(f.scope, { kind: 'principal', controlTarget: control.target }, Date.now())
          .then(
            () => null,
            (error: unknown) => error,
          );
        const timeout = setTimeout(release, 5000);
        try {
          await started;
          const owner = { userId: f.owner, ...(tenantId && { tenantId }) };
          const key = responseScopeKeys(owner, '')[0];
          await closeResponseScopes(mongoose, owner);
          const anchor = await createResponseScopeModel(mongoose).findById(key).lean();
          const entry = anchor!.pending!.find((row) => row.target.kind === 'channelLane')!;
          expect(await retireManagedAllocation(mongoose, entry.target, entry.target.id)).toBe(true);
        } finally {
          clearTimeout(timeout);
          release();
        }
        expect(await publishing).toMatchObject({ code: 'invalid_transition' });
        expect(
          await mongoose
            .model('ChannelLane')
            .countDocuments({ channelId: f.scope.channelId, kind: 'principal' }),
        ).toBe(0);
      }));

    it('recovers a fully published control after its update reply is lost', () =>
      scoped(async () => {
        const f = await fixture();
        const collection = mongoose.model('ChannelLane').collection;
        const write = collection.updateOne.bind(collection);
        let injected = false;
        jest.spyOn(collection, 'updateOne').mockImplementation(async (...args) => {
          const result = await write(...args);
          if (!injected && !Array.isArray(args[1]) && args[1].$set?.kind === 'control') {
            injected = true;
            throw new Error('synthetic lost lane reply');
          }
          return result;
        });
        await expect(f.storage.acquire(f.scope, { kind: 'control' }, Date.now())).rejects.toThrow(
          'synthetic lost lane reply',
        );
        const before = await mongoose
          .model('ChannelLane')
          .collection.findOne({ channelId: f.scope.channelId });
        const recovered = await f.storage.acquire(f.scope, { kind: 'control' }, Date.now());
        expect(recovered.target.id).toBe(String(before!._id));
        expect(
          await mongoose.model('ChannelLane').countDocuments({ channelId: f.scope.channelId }),
        ).toBe(1);
      }));

    it('validates control/principal field separation on actual model documents', () =>
      scoped(async () => {
        const f = await fixture();
        const control = await f.storage.acquire(f.scope, { kind: 'control' }, Date.now());
        const bad = new (mongoose.model('ChannelLane'))({
          ...control.record,
          userId: f.owner,
          conversationId: 'private-conversation',
        });
        await expect(bad.validate()).rejects.toThrow('Invalid lane kind field');
      }));
  });
});
