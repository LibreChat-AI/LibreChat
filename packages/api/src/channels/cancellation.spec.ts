import mongoose from 'mongoose';
import { randomUUID, createHash } from 'node:crypto';
import { MongoMemoryServer, MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  createModels,
  tenantStorage,
  channelRunFence,
  channelRunKeyBinding,
  createMethods,
  createChannelRunStorage,
  createChannelIdentityStorage,
  createResponseStorage,
  createManagedMessageId,
  channelResponseRequest,
} from '@librechat/data-schemas';
import {
  canonicalResponseJSON,
  buildPendingBackgroundResponse,
} from '~/agents/responses/background';
import { InMemoryEventTransport } from '~/stream/implementations/InMemoryEventTransport';
import { InMemoryJobStore } from '~/stream/implementations/InMemoryJobStore';
import { createResponseRetirement } from '~/agents/responses/retirement';
import { createChannelResponseRetirement } from './responses';
import { GenerationJobManager } from '~/stream';

const engines = ['standalone', 'replica', ...(process.env.FERRETDB_URI ? ['FerretDB'] : [])];
describe.each(engines)('cancel before first Response request on %s', (engine) => {
  let server: MongoMemoryServer | MongoMemoryReplSet | undefined;
  beforeAll(async () => {
    if (engine === 'replica') server = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    else if (engine === 'standalone') server = await MongoMemoryServer.create();
    createModels(mongoose);
    await mongoose.connect(server?.getUri() ?? process.env.FERRETDB_URI!, {
      dbName: `channel_cancellation_${randomUUID().replace(/-/g, '')}`,
    });
  }, 60000);
  beforeEach(() => {
    GenerationJobManager.configure({
      jobStore: new InMemoryJobStore(),
      eventTransport: new InMemoryEventTransport(),
      cleanupOnComplete: false,
    });
    GenerationJobManager.initialize();
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await GenerationJobManager.destroy();
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await server?.stop();
  });

  describe.each([undefined, 'cancellation-tenant'])('tenant %s', (tenantId) => {
    it.each([
      'no-post',
      'per-user',
      'cancel-first',
      'normal-first',
      'terminal-stream-false',
      'terminal-before-bind',
      'lost-reply',
      'bad-fingerprint',
    ] as const)('fences a gateway request racing cancellation: %s', (point) =>
      tenantStorage.run({ tenantId }, async () => {
        const owner = String(new mongoose.Types.ObjectId());
        const channelId = randomUUID();
        const creator = point === 'per-user' ? String(new mongoose.Types.ObjectId()) : owner;
        const linkId = randomUUID();
        const channels = createMethods(mongoose);
        await channels.createAgentChannel({
          channelId,
          createdBy: creator,
          agentId: 'agent',
          type: 'slack',
          status: 'active',
          credentialMode: point === 'per-user' ? 'per_user' : 'shared',
          revision: 'one',
          slack: { teamId: 'T', appId: 'A', botUserId: 'B' },
        });
        if (point === 'per-user')
          expect(
            await createChannelIdentityStorage(mongoose).saveChannelIdentity(
              {
                tenantId: tenantId || '_',
                linkId,
                revision: 'link-one',
                state: 'active',
                userId: owner,
                ticketHash: randomUUID(),
                ticketExpiresAtMs: Date.now() + 60000,
                expiresAtMs: Date.now() + 600000,
                identity: {
                  tenantId: tenantId || '_',
                  channelId,
                  channelRevision: 'one',
                  agentId: 'agent',
                  teamId: 'T',
                  externalUserId: 'U',
                },
              },
              null,
            ),
          ).toBe(true);
        const storage = createChannelRunStorage(mongoose);
        await storage.admit(
          {
            tenantId: tenantId || '_',
            channelId,
            agentId: 'agent',
            principal: {
              userId: owner,
              channelRevision: 'one',
              ...(point === 'per-user' && { linkId, linkRevision: 'link-one' }),
            },
            admission: {
              eventId: randomUUID(),
              externalChannelId: 'C',
              externalThreadKey: 'C:1',
              externalMessageKey: 'C:2',
              actor: { teamId: 'T', appId: 'A', externalUserId: 'U' },
              input: 'An admitted request that never reached Responses',
            },
          },
          100,
        );
        const claimed = (await storage.claim(tenantId || '_', channelId, 'gateway', 101, 1000))!;
        const prepared = await storage.prepareExecution(
          tenantId || '_',
          channelRunFence(claimed),
          102,
        );
        const key = await channels.createAgentApiKey({
          userId: owner,
          name: 'Provisioned before gateway crash',
          binding: channelRunKeyBinding(prepared),
        });
        const provisioned = await storage.attachResponseCredential(
          tenantId || '_',
          channelRunFence(prepared),
          { apiKeyId: key.id, encryptedApiKey: 'fixture-encrypted-key' },
          103,
        );
        await channels.updateAgentChannel(channelId, creator, { status: 'disabled' });
        const cleanup = (await storage.claimAuthorityLost(provisioned, 'cleanup', 104, 1000))!;
        const responses = createResponseStorage(mongoose);
        expect(cleanup.execution?.responseId).toBeUndefined();
        const canonicalRetire = createResponseRetirement({
          storage: responses,
          jobs: GenerationJobManager,
        });
        const retire = createChannelResponseRetirement({
          storage: responses,
          recovery: storage,
          now: () => 105,
          retireResponse: canonicalRetire,
        });
        const body = channelResponseRequest(cleanup);
        const normalRequest = ['normal-first', 'terminal-stream-false'].includes(point)
          ? { ...body, stream: false }
          : body;
        const requestJSON = canonicalResponseJSON(normalRequest);
        const normalReservation = {
          userId: owner,
          ...(tenantId && { tenantId }),
          responseId: createManagedMessageId(),
          requestKey: `channel:${cleanup.runId}`,
          sourceKeyId: key.id,
          agentId: cleanup.agentId,
          requestJSON,
          fingerprint: createHash('sha256').update(requestJSON).digest('hex'),
          conversationId: cleanup.execution!.conversationId,
          parentMessageId: cleanup.execution!.parentMessageId,
          dispatch: true,
        };
        if (point === 'bad-fingerprint') {
          const foreignJSON = canonicalResponseJSON({ ...body, input: 'Another request' });
          const foreign = await responses.reserve({
            ...normalReservation,
            requestJSON: foreignJSON,
            fingerprint: createHash('sha256').update(foreignJSON).digest('hex'),
          });
          if (!foreign.ok) throw new Error('Expected different request fixture');
          expect(await canonicalRetire(foreign.record, foreign.record.responseId)).toBe('stopped');
          await expect(retire(cleanup)).rejects.toMatchObject({ code: 'invalid_transition' });
          expect(
            (await storage.read(tenantId || '_', channelId, cleanup.runId))!.execution!.responseId,
          ).toBeUndefined();
          return;
        }
        const roots = mongoose.models.StoredResponse.collection;
        const publish = roots.findOneAndUpdate.bind(roots);
        let release!: () => void;
        let enter!: () => void;
        const entered = new Promise<void>((resolve) => {
          enter = resolve;
        });
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        let paused = false;
        jest.spyOn(roots, 'findOneAndUpdate').mockImplementation(async (...args) => {
          const cancellation = !Array.isArray(args[1]) && args[1].$set?.cancellationRequestedAt;
          if (!cancellation || paused || ['no-post', 'per-user'].includes(point))
            return publish(...args);
          paused = true;
          if (['normal-first', 'terminal-stream-false'].includes(point)) {
            enter();
            await gate;
            return publish(...args);
          }
          const result = await publish(...args);
          if (point === 'lost-reply') throw new Error('Lost cancellation publication reply');
          enter();
          await gate;
          return result;
        });
        const stopping = retire(cleanup);
        void stopping.catch(() => undefined);
        const timeout = setTimeout(release, 10000);
        try {
          if (
            [
              'normal-first',
              'terminal-stream-false',
              'cancel-first',
              'terminal-before-bind',
            ].includes(point)
          ) {
            await entered;
            if (['normal-first', 'terminal-stream-false', 'cancel-first'].includes(point)) {
              const normal = await responses.reserve(normalReservation);
              if (!normal.ok) throw new Error('Expected real request slot winner');
              expect(normal.replayed).toBe(point === 'cancel-first');
              if (point === 'terminal-stream-false') {
                expect(await canonicalRetire(normal.record, normal.record.responseId)).toBe(
                  'stopped',
                );
                expect(
                  (await responses.read(normal.record, normal.record.responseId))?.requestJSON,
                ).toBe('{}');
              }
              if (point === 'cancel-first') {
                expect(normal.record.cancellationRequestedAt).toBe(105);
                expect(
                  (
                    await responses.enrollExecution(
                      { ...normal.record, cancellationRequestedAt: undefined },
                      {
                        generationCreatedAt: Date.now(),
                        providerExecutionId: randomUUID(),
                      },
                      JSON.stringify(buildPendingBackgroundResponse(normal.record)),
                    )
                  ).ok,
                ).toBe(false);
              }
            } else {
              const row = await roots.findOne({ requestKey: normalReservation.requestKey });
              if (!row) throw new Error('Expected cancellation publication');
              const canonical = await responses.read(normalReservation, row.responseId);
              if (!canonical) throw new Error('Expected visible cancellation Root');
              expect(await canonicalRetire(canonical, canonical.responseId)).toBe('stopped');
              expect((await responses.read(canonical, canonical.responseId))?.requestJSON).toBe(
                '{}',
              );
            }
            release();
          }
          expect(await stopping).toBe('stopped');
        } finally {
          clearTimeout(timeout);
          release();
          await stopping.catch(() => undefined);
        }
        const captured = (await storage.read(tenantId || '_', channelId, cleanup.runId))!;
        expect(captured.execution?.responseId).toBeDefined();
        expect(captured.execution?.responseTarget).toBeDefined();
        const canonical = await responses.read(
          { userId: owner, ...(tenantId && { tenantId }) },
          captured.execution!.responseId!,
        );
        expect(canonical).toMatchObject({
          status: 'cancelled',
          userId: owner,
          sourceKeyId: key.id,
          requestKey: `channel:${cleanup.runId}`,
        });
        expect(canonical?.generationCreatedAt).toBeUndefined();
        expect(await GenerationJobManager.getJob(canonical!.responseId)).toBeUndefined();
        expect(await roots.countDocuments({ requestKey: normalReservation.requestKey })).toBe(1);
      }),
    );
  });
});
