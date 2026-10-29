import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import { Constants } from 'librechat-data-provider';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  createModels,
  createMethods,
  createChannelRunStorage,
  tenantStorage,
} from '@librechat/data-schemas';
import type { ChannelRunRecord } from '@librechat/data-schemas';
import type { ChannelExecutionDependencies } from './execution';
import { createChannelExecutionAdapter } from './execution';
import { createChannelHandlers } from './service';
import { createChannelRunHandlers } from './runs';

const scope = <T>(work: () => Promise<T>) => tenantStorage.run({ tenantId: 'tenant-a' }, work);
const makeRun = (): ChannelRunRecord => ({
  tenantId: 'tenant-a',
  channelId: 'channel-a',
  agentId: 'agent-a',
  runId: 'channel-run-a',
  laneId: 'lane-a',
  state: 'executing',
  sequence: 1,
  receivedAt: Date.now(),
  payloadHash: 'hash-a',
  principal: {
    userId: 'user-a',
    channelRevision: 'revision-a',
    linkId: 'link-a',
    linkRevision: 'link-rev-a',
  },
  admission: {
    eventId: 'event-a',
    externalChannelId: 'C1',
    externalThreadKey: 'C1:1.001',
    externalMessageKey: 'C1:1.001',
    actor: { teamId: 'T1', appId: 'A1', externalUserId: 'U1' },
    input: 'hello',
  },
  cancellationRequested: false,
  receipts: [],
  leaseEpoch: 1,
  leaseExpiresAt: Date.now() + 60_000,
  execution: {
    requestId: 'channel-run-a',
    conversationId: 'conversation-a',
    parentMessageId: String(Constants.NO_PARENT),
  },
});

describe('mounted service-token advance cannot execute an unbound run', () => {
  let mongo: MongoMemoryReplSet;
  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(mongo.getUri());
    createModels(mongoose);
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await mongo?.stop();
  });
  it('rejects legacy and unprepared state behind the actual service guard without starting work', () =>
    scope(async () => {
      const fixture = makeRun();
      await mongoose.models.AgentChannel.create({
        channelId: fixture.channelId,
        tenantId: fixture.tenantId,
        agentId: fixture.agentId,
        createdBy: fixture.principal.userId,
        type: 'slack',
        status: 'active',
        credentialMode: 'per_user',
        revision: fixture.principal.channelRevision,
        slack: { teamId: 'T1', appId: 'A1', botUserId: 'UBOT' },
      });
      const storage = createChannelRunStorage(mongoose);
      await storage.admit(
        {
          tenantId: fixture.tenantId,
          channelId: fixture.channelId,
          agentId: fixture.agentId,
          principal: fixture.principal,
          admission: fixture.admission,
        },
        Date.now(),
      );
      const run = (await storage.claim(
        fixture.tenantId,
        fixture.channelId,
        'worker',
        Date.now(),
        60_000,
      ))!;
      const token = 'test-service-credential-at-least-32-characters';
      const handlers = createChannelHandlers({
        db: createMethods(mongoose),
        serviceToken: () => token,
        config: async () => ({ enabled: true }),
        getAgent: async () => ({ id: fixture.agentId }),
        deleteApiKey: async () => true,
        verifySlackToken: async () => null,
        logError: jest.fn(),
      });
      const responseProjection = jest.fn();
      const adapter = createChannelExecutionAdapter({
        responseRetirement: jest.fn(),
        responseProjection,
      });
      const runs = createChannelRunHandlers({
        storage,
        guard: handlers.service,
        resolvePrincipal: async () => fixture.principal,
        advance: adapter.advance,
        retireForAuthorityLoss: adapter.retireForAuthorityLoss,
      });
      const app = express();
      app.use(express.json());
      app.post('/service/:channelId/runs/:runId/advance', runs.advance);
      const route = `/service/${run.channelId}/runs/${run.runId}/advance`;
      const body = { fence: { runId: run.runId, owner: run.leaseOwner, epoch: run.leaseEpoch } };
      await request(app).post(route).send(body).expect(401);
      for (let attempt = 0; attempt < 2; attempt++) {
        await request(app)
          .post(route)
          .auth(token, { type: 'bearer' })
          .set('X-Tenant-Id', fixture.tenantId)
          .send(body)
          .expect(409, { error: 'execution_not_prepared' });
      }
      const held = await storage.read(run.tenantId, run.channelId, run.runId);
      expect(held?.execution?.enqueueAttemptedAt).toBeUndefined();
      expect(held?.execution?.deliveryKey).toBeUndefined();
      expect(held?.snapshot).toBeUndefined();
      expect(responseProjection).not.toHaveBeenCalled();
    }));
});

describe('Responses-only Channels execution', () => {
  let run: ChannelRunRecord;
  let deps: ChannelExecutionDependencies;
  let adapter: ReturnType<typeof createChannelExecutionAdapter>;

  beforeEach(() => {
    run = makeRun();
    deps = {
      responseProjection: jest.fn(async () => ({
        snapshot: { status: 'running' as const, text: '', elapsedMs: 1 },
      })),
      responseRetirement: jest.fn(async () => 'pending' as const),
    };
    adapter = createChannelExecutionAdapter(deps);
  });

  function loseAuthority() {
    run.cancellationRequested = true;
    run.errorCode = 'channel_authority_changed';
  }

  it.each(['unprepared', 'unbound', 'legacy_dispatched', 'responses_unbound'] as const)(
    'refuses %s advance without projecting a Response',
    async (kind) => {
      if (kind === 'unprepared') run.execution = undefined;
      if (kind === 'legacy_dispatched') run.execution!.deliveryKey = 'old-trigger';
      if (kind === 'responses_unbound') run.execution!.protocol = 'responses';
      await expect(adapter.advance(run)).rejects.toMatchObject({ code: 'execution_not_prepared' });
      expect(deps.responseProjection).not.toHaveBeenCalled();
    },
  );

  it('delegates a bound Response to its canonical projection and retirement', async () => {
    run.execution = { ...run.execution!, protocol: 'responses', responseId: 'resp_saved' };
    await expect(adapter.advance(run)).resolves.toMatchObject({ snapshot: { status: 'running' } });
    expect(deps.responseProjection).toHaveBeenCalledWith(run);
    loseAuthority();
    await expect(adapter.retireForAuthorityLoss(run)).resolves.toBe('pending');
    expect(deps.responseRetirement).toHaveBeenCalledWith(run);
  });

  it.each(['not_cancelled', 'different_reason'] as const)(
    'rejects %s cleanup before consulting Responses',
    async (kind) => {
      loseAuthority();
      if (kind === 'not_cancelled') run.cancellationRequested = false;
      if (kind === 'different_reason') run.errorCode = 'other';
      await expect(adapter.retireForAuthorityLoss(run)).rejects.toMatchObject({
        code: 'execution_identity_changed',
      });
      expect(deps.responseRetirement).not.toHaveBeenCalled();
    },
  );

  it.each(['unprepared', 'unprovisioned', 'responses_unprovisioned'] as const)(
    'retires %s authority loss without a possible provider admission',
    async (kind) => {
      loseAuthority();
      if (kind === 'unprepared') run.execution = undefined;
      if (kind === 'responses_unprovisioned') run.execution!.protocol = 'responses';
      await expect(adapter.retireForAuthorityLoss(run)).resolves.toBe('stopped');
      expect(deps.responseRetirement).not.toHaveBeenCalled();
    },
  );

  it('reconciles an issued credential even when Response binding has not finished', async () => {
    loseAuthority();
    run.execution = { ...run.execution!, protocol: 'responses', apiKeyId: 'issued' };
    await expect(adapter.retireForAuthorityLoss(run)).resolves.toBe('pending');
    expect(deps.responseRetirement).toHaveBeenCalledWith(run);
  });

  it.each([
    'deliveryKey',
    'enqueueAttemptedAt',
    'generationCreatedAt',
    'apiKeyId',
    'responseId',
  ] as const)(
    'holds unknown execution with %s instead of guessing that it stopped',
    async (field) => {
      loseAuthority();
      Object.assign(run.execution!, { [field]: field.endsWith('At') ? 100 : 'unknown' });
      await expect(adapter.retireForAuthorityLoss(run)).rejects.toMatchObject({
        code: 'execution_identity_changed',
      });
      expect(deps.responseRetirement).not.toHaveBeenCalled();
    },
  );

  it('preserves canonical retirement errors for recovery to retry', async () => {
    loseAuthority();
    run.execution = { ...run.execution!, protocol: 'responses', responseId: 'resp_saved' };
    const error = new Error('storage_unavailable');
    jest.mocked(deps.responseRetirement).mockRejectedValue(error);
    await expect(adapter.retireForAuthorityLoss(run)).rejects.toBe(error);
  });
});
