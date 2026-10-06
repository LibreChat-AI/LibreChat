import { z } from 'zod';
import { Keyv } from 'keyv';
import Redis from 'ioredis';
import mongoose from 'mongoose';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { ToolNode } from '@librechat/agents';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { AIMessage } from '@librechat/agents/langchain/messages';
import { createModels, createMethods } from '@librechat/data-schemas';
import { DEFAULT_MCP_APP_OPERATION_LIMITS } from 'librechat-data-provider';
import type { ScheduledMCPTarget, ScheduledMCPReadOnlyPolicy } from 'librechat-data-provider';
import type { IScheduleRun, IUser } from '@librechat/data-schemas';
import type { IJobStoreV2, ScheduleProviderOwner } from '~/stream/interfaces/IJobStore';
import type { ScheduledMCPBearerResult } from './authorization/contract';
import type { MCPOAuthTokens } from '~/mcp/oauth/types';
import type { SchedulesServiceDeps } from './service';
import type { ParsedServerConfig } from '~/mcp/types';
import {
  attachScheduledMCPBearer,
  ScheduledMCPBearerError,
  createScheduledMCPBearerHost,
  bindScheduledMCPBearerInvocation,
} from './bearer';
import {
  createMCPRequestContext,
  cleanupMCPRequestContext,
  quiesceMCPRequestContext,
} from '~/mcp/request';
import { createScheduleMCPExecution, bindScheduledMCPInvocation } from './authorization/execution';
import { getScheduledMCPPolicyRevision, ScheduledMCPPolicyError } from './authorization/policy';
import { InMemoryEventTransport } from '~/stream/implementations/InMemoryEventTransport';
import { createSchedulesService, recordScheduledMCPToolAuthFailure } from './service';
import { getScheduledMCPConfigurationRevision } from './authorization/configuration';
import { createOAuthMCPServer } from '~/mcp/__tests__/helpers/oauthTestServer';
import { InMemoryJobStore } from '~/stream/implementations/InMemoryJobStore';
import { createScheduleMCPConsentService } from './authorization/service';
import { MCPServersRegistry } from '~/mcp/registry/MCPServersRegistry';
import { RedisJobStore } from '~/stream/implementations/RedisJobStore';
import { GenerationJobManager } from '~/stream/GenerationJobManager';
import { MCPConnectionFactory } from '~/mcp/MCPConnectionFactory';
import { MCP_APPS_CAPABILITY_PROFILE } from '~/mcp/capabilities';
import { FlowStateManager } from '~/flow/manager';
import { MCPConnection } from '~/mcp/connection';
import { MCPManager } from '~/mcp/MCPManager';

async function fixture(
  store: IJobStoreV2 = new InMemoryJobStore({ ttlAfterComplete: 0 }),
  retainInitially = false,
) {
  const mongo = await MongoMemoryServer.create({ instance: { args: ['--nounixsocket'] } });
  const database = new mongoose.Mongoose();
  await database.connect(mongo.getUri(), { autoIndex: false });
  createModels(database);
  const methods = createMethods(database);
  const principal = new database.Types.ObjectId();
  const owner = principal.toString();
  const scheduledFor = new Date('2026-10-04T00:00:00Z');
  const schedule = await methods.createSchedule({
    id: 'barrier',
    user: principal,
    agent_id: 'root',
    name: 'Read',
    prompt: 'Read',
    cadence: { frequency: 'daily', hour: 8, minute: 0 },
    timezone: 'UTC',
    target: 'new',
    enabled: true,
  });
  await methods.reserveStartedRun({
    scheduleId: schedule.id,
    user: principal,
    scheduledFor,
    conversationId: 'conversation',
    capacitySlot: 0,
  });
  GenerationJobManager.configure({
    jobStore: store,
    eventTransport: new InMemoryEventTransport(),
    isRedis: store instanceof RedisJobStore,
    cleanupOnComplete: true,
  });
  GenerationJobManager.initialize();
  const job = await GenerationJobManager.createJob('conversation', owner, 'conversation', {
    initialMetadata: {
      scheduleId: schedule.id,
      scheduledFor: scheduledFor.toISOString(),
      agent_id: 'root',
      ...(retainInitially && { preserveForScheduleReconcile: true }),
    },
  });
  const identity = {
    scheduleId: schedule.id,
    ownerId: owner,
    tenantId: null,
    agentId: 'root',
    invocationMode: 'delegated' as const,
  };
  const dependencies = {
    methods: {
      ...methods,
      getRoleByName: async () => null,
      getFiles: async () => [],
      extendFilesTTL: async () => 0,
    },
    preflightMCP: async () => [],
    getAppConfig: async () => undefined,
    findUserById: async () => null,
    findBalance: async () => null,
    upsertBalance: async () => null,
    initializeNullBalance: async () => null,
    resolveAgentFireAccess: async () => 'ok',
    getChatProject: async () => null,
    isUserDeleting: async () => false,
    enqueueAgentTrigger: async () => undefined,
    getTriggerDelivery: async () => null,
  } satisfies SchedulesServiceDeps;
  const service = createSchedulesService(dependencies, { drainTimeoutMs: 1, drainPollMs: 1 });
  const outcome = {
    scheduleId: schedule.id,
    scheduledFor,
    streamId: job.streamId,
    jobCreatedAt: job.createdAt,
    conversationId: job.streamId,
    status: 'success' as const,
  };
  const close = async () => {
    jest.restoreAllMocks();
    GenerationJobManager.setApprovalExpiredHandler(undefined);
    await GenerationJobManager.destroy({ settlementBudgetMs: 0 });
    await database.disconnect();
    await mongo.stop();
  };
  return {
    database,
    methods,
    owner,
    schedule,
    scheduledFor,
    store,
    job,
    identity,
    service,
    dependencies,
    outcome,
    close,
  };
}

it.each([
  ['delete', 'provider'],
  ['quiesce', 'provider'],
  ['delete', 'persistence'],
  ['quiesce', 'persistence'],
  ['delete', 'host'],
  ['quiesce', 'host'],
] as const)(
  'keeps %s settlement and capacity behind the retained %s barrier',
  async (mode, barrier) => {
    const f = await fixture();
    try {
      const error = new ScheduledMCPBearerError('consent_revoked', 'Files');
      await f.service.recordMCPToolAuthFailure({
        error,
        identity: f.identity,
        streamId: f.job.streamId,
        jobCreatedAt: f.job.createdAt,
        userId: f.owner,
        serverName: 'Files',
      });
      if (barrier === 'provider')
        await GenerationJobManager.beginProviderExecution(
          f.job.streamId,
          f.job.createdAt,
          f.job.metadata.providerExecutionId!,
        );
      const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 60 * 60_000);
      await f.store.cleanup();
      clock.mockRestore();
      if (barrier !== 'provider')
        await f.store.updateJob(
          f.job.streamId,
          {
            ...(barrier === 'persistence'
              ? { terminalPersistencePending: true, terminalPersistenceStartedAt: Date.now() }
              : { terminalHostActionPending: true }),
          },
          f.job.createdAt,
        );
      expect((await f.store.getJob(f.job.streamId))?.status).toBe('error');
      // A failed drain cannot count as delivery, even when its terminal status is already visible.
      const abort = jest.spyOn(f.service.engineDeps, 'abortScheduledJob').mockResolvedValue(false);
      const result =
        mode === 'delete'
          ? await f.service.deleteScheduleForOwner(f.schedule.id, f.owner)
          : await f.service.quiesceUserSchedules(f.owner, 'attempt');
      expect(result).toBe(mode === 'delete' ? 'unconfirmed' : false);
      expect(await f.methods.getScheduleRunAbortState(f.schedule.id, f.scheduledFor)).toMatchObject(
        { status: 'started' },
      );
      expect(
        await f.database.model('ScheduleRun').findOne({ scheduleId: f.schedule.id }).lean(),
      ).toMatchObject({ capacitySlot: 0 });
      if (barrier === 'provider')
        expect((await f.store.getJob(f.job.streamId))?.providerDrained).toBe(false);
      abort.mockRestore();
      if (barrier === 'provider')
        await GenerationJobManager.markProviderExecutionDrained(
          f.job.streamId,
          f.job.createdAt,
          f.job.metadata.providerExecutionId!,
        );
      else
        await f.store.updateJob(
          f.job.streamId,
          { terminalPersistencePending: false, terminalHostActionPending: false },
          f.job.createdAt,
        );
      await f.service.reconcileRetainedJobs();
      expect(
        (
          await f.database
            .model('ScheduleRun')
            .findOne({ scheduleId: f.schedule.id })
            .lean<IScheduleRun>()
        )?.capacitySlot,
      ).toBeUndefined();
    } finally {
      await f.close();
    }
  },
  30_000,
);

it.each(['consent_revoked', 'credential_rejected'] as const)(
  'persists a notification-only %s before disposal and handled-success settlement',
  async (reason) => {
    const f = await fixture();
    const server = await createOAuthMCPServer();
    const context = createMCPRequestContext();
    let connection: MCPConnection | undefined;
    let denied = false;
    let available = false;
    const error = new ScheduledMCPBearerError(reason, 'Files');
    const record = jest.fn(async (failure: ScheduledMCPBearerError) =>
      recordScheduledMCPToolAuthFailure(
        {
          error: failure,
          identity: f.identity,
          streamId: f.job.streamId,
          jobCreatedAt: f.job.createdAt,
          userId: f.owner,
          serverName: 'Files',
        },
        () => f.service.recordMCPToolAuthFailure,
      ),
    );
    try {
      const persist = f.service.engineDeps.methods.recordMCPToolAuthFailure;
      f.service.engineDeps.methods.recordMCPToolAuthFailure = async (input) => {
        if (!available) throw new Error('receipt store unavailable');
        return persist(input);
      };
      server.issuedTokens.add('notification-only');
      server.tokenIssueTimes.set('notification-only', Date.now());
      attachScheduledMCPBearer(
        context,
        f.identity,
        {
          bind: (identity) => ({
            identity,
            reject: () => {},
            resolve: async (input) => {
              if (denied) throw error;
              return { ...input.config, headers: { Authorization: 'Bearer notification-only' } };
            },
          }),
        },
        'invoke',
        undefined,
        { onFailure: record },
      );
      const definition: ParsedServerConfig = {
        type: 'streamable-http',
        url: server.url,
        requiresOAuth: false,
        source: 'yaml',
        headers: { Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}' },
      };
      connection = await MCPConnectionFactory.create(
        {
          serverName: 'Files',
          serverConfig: definition,
          ephemeralConnection: true,
          useSSRFProtection: false,
        },
        { user: { id: f.owner } as IUser, requestScopedConnections: context },
      );
      context.connections.set('Files', connection);
      await connection.fetchToolsSnapshot();
      if (reason === 'consent_revoked') denied = true;
      else server.issuedTokens.clear();
      await server.notifyToolsChanged();
      const deadline = Date.now() + 2000;
      while (record.mock.calls.length === 0 && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(record).toHaveBeenCalledWith(error);
      expect(Reflect.get(connection, 'shouldStopReconnecting')).toBe(true);
      await f.store.updateJob(
        f.job.streamId,
        { status: 'complete', completedAt: Date.now() },
        f.job.createdAt,
      );
      await expect(f.service.recordScheduleOutcome(f.outcome)).resolves.toBe(false);
      let disposed = false;
      const cleanup = cleanupMCPRequestContext(context).then(() => {
        disposed = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(disposed).toBe(false);
      available = true;
      await cleanup;
      await expect(f.service.recordScheduleOutcome(f.outcome)).resolves.toBe(true);
      expect(await f.methods.getScheduleRunAbortState(f.schedule.id, f.scheduledFor)).toMatchObject(
        {
          status: 'error',
          mcp: error.outcomes,
        },
      );
      expect(await f.methods.getScheduleById(f.schedule.id)).toMatchObject({
        enabled: false,
        disabledReason: 'mcp_reauth_required',
        lastRun: { status: 'error', mcp: error.outcomes },
      });
    } finally {
      available = true;
      await connection?.dispose();
      await cleanupMCPRequestContext(context);
      MCPConnection.clearCooldown('Files');
      await server.close();
      await f.close();
    }
  },
  30_000,
);

it.each(['delete', 'quiesce'] as const)(
  'keeps %s cleanup abort behind the real pending approval host action',
  async (mode) => {
    const f = await fixture();
    const record = jest.spyOn(f.service.engineDeps.methods, 'recordRunOutcome');
    try {
      const error = new ScheduledMCPBearerError('consent_revoked', 'Files');
      await f.service.recordMCPToolAuthFailure({
        error,
        identity: f.identity,
        streamId: f.job.streamId,
        jobCreatedAt: f.job.createdAt,
        userId: f.owner,
        serverName: 'Files',
      });
      await f.store.transitionStatus(f.job.streamId, {
        from: 'running',
        to: 'aborted',
        expectCreatedAt: f.job.createdAt,
        patch: {
          completedAt: Date.now(),
          error: 'Approval expired before a decision was made',
          terminalHostActionPending: true,
        },
      });
      const result =
        mode === 'delete'
          ? await f.service.deleteScheduleForOwner(f.schedule.id, f.owner)
          : await f.service.quiesceUserSchedules(f.owner, 'attempt');
      expect(result).toBe(mode === 'delete' ? 'unconfirmed' : false);
      expect(record).not.toHaveBeenCalled();
      expect(
        await f.database.model('ScheduleRun').findOne({ scheduleId: f.schedule.id }).lean(),
      ).toMatchObject({ status: 'started', capacitySlot: 0 });
      expect((await f.store.getJob(f.job.streamId))?.terminalHostActionPending).toBe(true);
      // Only the owning host callback may settle the operation it still owes.
      const acknowledge = jest.fn(async () => {
        const settled = await f.service.recordScheduleOutcome({
          ...f.outcome,
          status: 'interrupted',
        });
        if (!settled) throw new Error('Host settlement deferred');
      });
      GenerationJobManager.setApprovalExpiredHandler(acknowledge);
      await GenerationJobManager['expireStaleApprovals']();
      expect(acknowledge).toHaveBeenCalledTimes(1);
      expect((await f.store.getJob(f.job.streamId))?.terminalHostActionPending).not.toBe(true);
      await f.service.reconcileRetainedJobs();
      expect(
        (
          await f.database
            .model('ScheduleRun')
            .findOne({ scheduleId: f.schedule.id })
            .lean<IScheduleRun>()
        )?.capacitySlot,
      ).toBeUndefined();
    } finally {
      await f.close();
    }
  },
  30_000,
);

const redisDescribe = process.env.B2_REDIS_SOCKET ? describe : describe.skip;
redisDescribe('real Redis scheduled provider drain', () => {
  it('holds real Redis schedule evidence and Mongo capacity until the exact provider acknowledges drain', async () => {
    const redis = new Redis({ path: process.env.B2_REDIS_SOCKET!, lazyConnect: true });
    await redis.connect();
    const f = await fixture(new RedisJobStore(redis));
    try {
      const error = new ScheduledMCPBearerError('consent_revoked', 'Files');
      await f.service.recordMCPToolAuthFailure({
        error,
        identity: f.identity,
        streamId: f.job.streamId,
        jobCreatedAt: f.job.createdAt,
        userId: f.owner,
        serverName: 'Files',
      });
      const segment = f.job.metadata.providerExecutionId!;
      await GenerationJobManager.beginProviderExecution(f.job.streamId, f.job.createdAt, segment);
      await f.store.transitionStatus(f.job.streamId, {
        from: 'running',
        to: 'error',
        expectCreatedAt: f.job.createdAt,
        patch: { completedAt: Date.now() - 60_000, terminalHostActionPending: true },
      });
      const restarted = new RedisJobStore(redis);
      await expect(restarted.hasScheduleCleanupObligation({ scheduleId: 'foreign' })).resolves.toBe(
        false,
      );
      await expect(restarted.hasScheduleCleanupObligation({ userId: f.owner })).resolves.toBe(true);
      await restarted.getTerminalHostActionJobs();
      await restarted.getScheduleReconcileJobs(100);
      await f.service.reconcileRetainedJobs();
      expect((await f.store.getJob(f.job.streamId))?.providerDrained).toBe(false);
      expect(
        await f.database.model('ScheduleRun').findOne({ scheduleId: f.schedule.id }).lean(),
      ).toMatchObject({ status: 'started', capacitySlot: 0 });
      expect((await f.store.getJob(f.job.streamId))?.scheduleOutcomeError).toContain(
        'consent_revoked',
      );
      await expect(
        restarted.markProviderExecutionDrained(f.job.streamId, f.job.createdAt, 'wrong-segment'),
      ).resolves.toBe(false);
      await GenerationJobManager.markProviderExecutionDrained(
        f.job.streamId,
        f.job.createdAt,
        segment,
      );
      await f.service.reconcileRetainedJobs();
      expect(await f.methods.getScheduleRunAbortState(f.schedule.id, f.scheduledFor)).toMatchObject(
        { status: 'error', mcp: error.outcomes },
      );
      expect(await f.store.getJob(f.job.streamId)).toBeNull();
    } finally {
      await f.close();
      await redis.quit();
    }
  }, 30_000);
});

redisDescribe('host-confirmed Redis provider owner loss', () => {
  it.each(['receipt', 'initial retention'] as const)(
    'recovers a terminated worker from %s without treating a live or unknown owner as drained',
    async (mode) => {
      const redis = new Redis({ path: process.env.B2_REDIS_SOCKET!, lazyConnect: true });
      await redis.connect();
      const f = await fixture(
        new RedisJobStore(redis, { runningTtl: 1 }),
        mode === 'initial retention',
      );
      let worker: ReturnType<typeof spawn> | undefined;
      let stopped = false;
      try {
        const error = new ScheduledMCPBearerError('consent_revoked', 'Files');
        if (mode === 'receipt')
          await f.service.recordMCPToolAuthFailure({
            error,
            identity: f.identity,
            streamId: f.job.streamId,
            jobCreatedAt: f.job.createdAt,
            userId: f.owner,
            serverName: 'Files',
          });
        const segment = f.job.metadata.providerExecutionId!;
        // This disposable process owns the provider segment. Only its observed exit proves loss.
        worker = spawn(
          process.execPath,
          [
            '-e',
            `const Redis=require('ioredis');const {RedisJobStore}=require('./dist/index.cjs');
        const client=new Redis({path:process.argv[1]});const store=new RedisJobStore(client);
        store.beginProviderExecution(process.argv[2],Number(process.argv[3]),process.argv[4]).then(started=>{
          if(!started)process.exit(2);process.stdout.write('started\\n');setInterval(()=>{},1000);
        }).catch(()=>process.exit(3));`,
            process.env.B2_REDIS_SOCKET!,
            f.job.streamId,
            String(f.job.createdAt),
            segment,
          ],
          { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
        );
        await new Promise<void>((resolve, reject) => {
          worker!.stdout!.once('data', () => resolve());
          worker!.once('error', reject);
          worker!.once('exit', (code) => {
            if (code !== null) reject(new Error('Provider worker failed to start'));
          });
        });
        const proveLoss = jest.fn(async (owner: ScheduleProviderOwner) => (stopped ? owner : null));
        const recovering = createSchedulesService({
          ...f.dependencies,
          confirmScheduleProviderOwnerLoss: proveLoss,
        });
        await redis.hset(
          `stream:{${f.job.streamId}}:job`,
          'lastActiveAt',
          String(Date.now() - 5000),
        );
        await recovering.reconcileRetainedJobs();
        expect((await f.store.getJob(f.job.streamId))?.providerDrained).toBe(false);
        expect(
          await f.methods.getScheduleRunAbortState(f.schedule.id, f.scheduledFor),
        ).toMatchObject({ status: 'started' });
        const old = (await f.store.getJob(f.job.streamId))!;
        const proof = {
          streamId: old.streamId,
          createdAt: old.createdAt,
          providerExecutionId: segment,
          scheduleId: f.schedule.id,
          scheduledFor: old.scheduledFor!,
          userId: f.owner,
          tenantId: null,
          lastActiveAt: old.lastActiveAt ?? old.createdAt,
        };
        const exited = once(worker, 'exit');
        worker.kill('SIGKILL');
        await exited;
        stopped = true;
        // Renewed liveness invalidates an earlier proof even at the same stream and epoch.
        await redis.hset(
          `stream:{${f.job.streamId}}:job`,
          'lastActiveAt',
          String(proof.lastActiveAt + 1),
        );
        await expect(f.store.recoverScheduleProviderOwnerLoss!(proof)).resolves.toBe(false);
        await expect(
          f.store.recoverScheduleProviderOwnerLoss!({ ...proof, userId: 'foreign' }),
        ).resolves.toBe(false);
        await recovering.reconcileRetainedJobs();
        expect(proveLoss).toHaveBeenCalledWith(
          expect.objectContaining({ providerExecutionId: segment, createdAt: f.job.createdAt }),
        );
        expect(
          await f.methods.getScheduleRunAbortState(f.schedule.id, f.scheduledFor),
        ).toMatchObject({ status: 'error', ...(mode === 'receipt' && { mcp: error.outcomes }) });
        expect(
          (
            await f.database
              .model('ScheduleRun')
              .findOne({ scheduleId: f.schedule.id })
              .lean<IScheduleRun>()
          )?.capacitySlot,
        ).toBeUndefined();
        expect(await f.store.getJob(f.job.streamId)).toBeNull();
      } finally {
        if (worker && !stopped) {
          const exited = once(worker, 'exit');
          worker.kill('SIGKILL');
          await exited;
        }
        await f.close();
        await redis.quit();
      }
    },
    30_000,
  );
});

it.each([401, 403] as const)(
  'records an automatic SDK SSE HTTP %s without another catalog or tool call',
  async (status) => {
    const f = await fixture();
    const failure = new ScheduledMCPBearerError(
      status === 403 ? 'resource_permission_denied' : 'credential_rejected',
      'Files',
    );
    let reject = false;
    let dispatched = 0;
    const server = await createOAuthMCPServer({
      onResourceRequest: () => {
        dispatched++;
      },
      resourceFailure: (req) => (reject && req.method === 'GET' ? status : undefined),
    });
    const context = createMCPRequestContext();
    let connection: MCPConnection | undefined;
    const retire = jest.fn();
    const resolve = jest.fn(async (input) => ({
      ...input.config,
      headers: { Authorization: 'Bearer automatic-only' },
    }));
    const record = jest.fn(async (error: ScheduledMCPBearerError) =>
      recordScheduledMCPToolAuthFailure(
        {
          error,
          identity: f.identity,
          streamId: f.job.streamId,
          jobCreatedAt: f.job.createdAt,
          userId: f.owner,
          serverName: 'Files',
        },
        () => f.service.recordMCPToolAuthFailure,
      ),
    );
    try {
      server.issuedTokens.add('automatic-only');
      server.tokenIssueTimes.set('automatic-only', Date.now());
      attachScheduledMCPBearer(
        context,
        f.identity,
        { bind: (identity) => ({ identity, resolve, reject: retire }) },
        'invoke',
        undefined,
        { onFailure: record },
      );
      const definition: ParsedServerConfig = {
        type: 'streamable-http',
        url: server.url,
        requiresOAuth: false,
        source: 'yaml',
        headers: { Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}' },
      };
      connection = await MCPConnectionFactory.create(
        {
          serverName: 'Files',
          serverConfig: definition,
          useSSRFProtection: false,
          ephemeralConnection: true,
        },
        { user: { id: f.owner } as IUser, requestScopedConnections: context },
      );
      context.connections.set('Files', connection);
      const transport = Reflect.get(connection, 'transport');
      const recover = jest.spyOn(transport, '_startOrAuthSse');
      Reflect.set(transport, '_reconnectionOptions', {
        initialReconnectionDelay: 1,
        maxReconnectionDelay: 1,
        reconnectionDelayGrowFactor: 1,
        maxRetries: 1,
      });
      reject = true;
      transport._scheduleReconnection({ resumptionToken: undefined });
      const deadline = Date.now() + 2000;
      while (record.mock.calls.length === 0 && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({
          failure: failure.failure,
        }),
      );
      expect(recover).toHaveBeenCalled();
      await expect(recover.mock.results[0].value).rejects.toMatchObject({
        failure: failure.failure,
      });
      expect(retire).toHaveBeenCalledWith('Files', failure.failure.reason);
      expect(Reflect.get(connection, 'shouldStopReconnecting')).toBe(true);
      const requests = dispatched;
      await cleanupMCPRequestContext(context);
      expect(dispatched).toBe(requests + 1); // The exempt session DELETE is teardown, not replay.
      await f.store.updateJob(
        f.job.streamId,
        { status: 'complete', completedAt: Date.now() },
        f.job.createdAt,
      );
      await expect(f.service.recordScheduleOutcome(f.outcome)).resolves.toBe(true);
      expect(await f.methods.getScheduleRunAbortState(f.schedule.id, f.scheduledFor)).toMatchObject(
        { status: 'error', mcp: failure.outcomes },
      );
      expect(await f.methods.getScheduleById(f.schedule.id)).toMatchObject({
        enabled: false,
        disabledReason: failure.failure.status,
        lastRun: { mcp: failure.outcomes },
      });
    } finally {
      await connection?.dispose();
      await cleanupMCPRequestContext(context);
      MCPConnection.clearCooldown('Files');
      await server.close();
      await f.close();
    }
  },
  30_000,
);

it('retains the terminal host obligation across failed acknowledgement and a new service instance', async () => {
  const f = await fixture();
  try {
    await f.service.recordMCPToolAuthFailure({
      error: new ScheduledMCPBearerError('consent_revoked', 'Files'),
      identity: f.identity,
      streamId: f.job.streamId,
      jobCreatedAt: f.job.createdAt,
      userId: f.owner,
      serverName: 'Files',
    });
    await f.store.transitionStatus(f.job.streamId, {
      from: 'running',
      to: 'aborted',
      expectCreatedAt: f.job.createdAt,
      patch: {
        completedAt: Date.now(),
        error: 'Approval expired before a decision was made',
        terminalHostActionPending: true,
      },
    });
    await f.methods.markScheduleDeleting(f.schedule.id, f.owner);
    const clear = jest
      .spyOn(f.store, 'clearTerminalHostAction')
      .mockRejectedValue(new Error('marker write unavailable'));
    GenerationJobManager.setApprovalExpiredHandler(async () => {
      if (!(await f.service.recordScheduleOutcome({ ...f.outcome, status: 'interrupted' })))
        throw new Error('Settlement deferred');
    });
    await GenerationJobManager['expireStaleApprovals']();
    const held = await f.store.getJob(f.job.streamId);
    expect(held).toMatchObject({
      terminalHostActionPending: true,
      preserveForScheduleReconcile: true,
    });
    expect(
      await f.database.model('ScheduleRun').findOne({ scheduleId: f.schedule.id }).lean(),
    ).toMatchObject({ status: 'error' });
    expect(await f.database.model('Schedule').findOne({ id: f.schedule.id }).lean()).not.toBeNull();
    const restarted = createSchedulesService(f.dependencies, { drainTimeoutMs: 1, drainPollMs: 1 });
    expect((await f.methods.getActiveRunsForUser(f.owner)).length).toBe(0);
    await expect(restarted.engineDeps.eraseSettledSchedule!(f.schedule.id)).resolves.toBe(false);
    await expect(restarted.quiesceUserSchedules(f.owner, 'attempt')).resolves.toBe(false);
    clear.mockRestore();
    await GenerationJobManager['expireStaleApprovals']();
    await restarted.reconcileRetainedJobs();
    expect(await f.store.getJob(f.job.streamId)).toBeNull();
    await expect(restarted.quiesceUserSchedules(f.owner, 'attempt')).resolves.toBe(true);
    expect(await f.database.model('Schedule').findOne({ id: f.schedule.id }).lean()).toBeNull();
  } finally {
    await f.close();
  }
}, 30_000);

it('drains an automatic rejection received during completion before the Mongo terminal write', async () => {
  const f = await fixture();
  let reject = false;
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const server = await createOAuthMCPServer({
    resourceFailure: async (req) => {
      if (!reject || req.method !== 'GET') return;
      entered();
      await gate;
      return 401;
    },
  });
  const context = createMCPRequestContext();
  let connection: MCPConnection | undefined;
  const record = jest.fn((error: ScheduledMCPBearerError) =>
    f.service.recordMCPToolAuthFailure({
      error,
      identity: f.identity,
      streamId: f.job.streamId,
      jobCreatedAt: f.job.createdAt,
      userId: f.owner,
      serverName: 'Files',
    }),
  );
  try {
    server.issuedTokens.add('completion-only');
    server.tokenIssueTimes.set('completion-only', Date.now());
    attachScheduledMCPBearer(
      context,
      f.identity,
      {
        bind: (identity) => ({
          identity,
          reject: () => {},
          resolve: async (input) => ({
            ...input.config,
            headers: { Authorization: 'Bearer completion-only' },
          }),
        }),
      },
      'invoke',
      undefined,
      { onFailure: record },
    );
    const quiesce = jest.fn(async () => {
      await quiesceMCPRequestContext(context);
    });
    f.service.registerMCPSettlement({
      identity: f.identity,
      streamId: f.job.streamId,
      jobCreatedAt: f.job.createdAt,
      quiesce,
    });
    const definition: ParsedServerConfig = {
      type: 'streamable-http',
      url: server.url,
      requiresOAuth: false,
      source: 'yaml',
      headers: { Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}' },
    };
    connection = await MCPConnectionFactory.create(
      {
        serverName: 'Files',
        serverConfig: definition,
        ephemeralConnection: true,
        useSSRFProtection: false,
      },
      { user: { id: f.owner } as IUser, requestScopedConnections: context },
    );
    context.connections.set('Files', connection);
    const transport = Reflect.get(connection, 'transport');
    reject = true;
    const reopening = transport
      ._startOrAuthSse({ resumptionToken: undefined })
      .catch((error: Error) => error);
    await started;
    await f.store.updateJob(
      f.job.streamId,
      { status: 'complete', completedAt: Date.now() },
      f.job.createdAt,
    );
    const writes = jest.spyOn(f.service.engineDeps.methods, 'recordRunOutcome');
    const settlement = f.service.recordScheduleOutcome(f.outcome);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const writtenBeforeDrain = writes.mock.calls.length;
    release();
    await reopening;
    const settled = await settlement;
    expect(writtenBeforeDrain).toBe(0);
    expect(settled).toBe(true);
    expect(quiesce).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalled();
    expect(await f.methods.getScheduleRunAbortState(f.schedule.id, f.scheduledFor)).toMatchObject({
      status: 'error',
      mcp: [expect.objectContaining({ reason: 'credential_rejected' })],
    });
    await expect(transport._startOrAuthSse({ resumptionToken: undefined })).rejects.toThrow();
  } finally {
    release();
    await connection?.dispose().catch(() => undefined);
    await cleanupMCPRequestContext(context);
    MCPConnection.clearCooldown('Files');
    await server.close();
    await f.close();
  }
}, 30_000);

it('tears down a real session after a fenced receipt without touching its successor', async () => {
  const f = await fixture();
  let denied = false;
  const server = await createOAuthMCPServer({
    resourceFailure: (req) => (denied && req.method === 'GET' ? 401 : undefined),
  });
  const context = createMCPRequestContext();
  let connection: MCPConnection | undefined;
  try {
    server.issuedTokens.add('retired-only');
    server.tokenIssueTimes.set('retired-only', Date.now());
    attachScheduledMCPBearer(
      context,
      f.identity,
      {
        bind: (identity) => ({
          identity,
          reject: () => {},
          resolve: async (input) => ({
            ...input.config,
            headers: { Authorization: 'Bearer retired-only' },
          }),
        }),
      },
      'invoke',
      undefined,
      {
        onFailure: (error) =>
          recordScheduledMCPToolAuthFailure(
            {
              error,
              identity: f.identity,
              streamId: f.job.streamId,
              jobCreatedAt: f.job.createdAt,
              userId: f.owner,
              serverName: 'Files',
            },
            () => f.service.recordMCPToolAuthFailure,
          ),
      },
    );
    const definition: ParsedServerConfig = {
      type: 'streamable-http',
      url: server.url,
      requiresOAuth: false,
      source: 'yaml',
      headers: { Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}' },
    };
    connection = await MCPConnectionFactory.create(
      {
        serverName: 'Files',
        serverConfig: definition,
        ephemeralConnection: true,
        useSSRFProtection: false,
      },
      { user: { id: f.owner } as IUser, requestScopedConnections: context },
    );
    context.connections.set('Files', connection);
    await f.store.deleteJob(f.job.streamId, f.job.createdAt);
    const successor = await GenerationJobManager.createJob(f.job.streamId, f.owner, f.job.streamId);
    denied = true;
    const transport = Reflect.get(connection, 'transport');
    await expect(transport._startOrAuthSse({ resumptionToken: undefined })).rejects.toMatchObject({
      name: 'AbortError',
    });
    const terminate = jest.spyOn(transport, 'terminateSession');
    const close = jest.spyOn(connection.client, 'close');
    await expect(connection.dispose()).rejects.toMatchObject({ name: 'AbortError' });
    expect(terminate).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
    expect(Reflect.get(connection, 'agents')).toHaveLength(0);
    expect((await f.store.getJob(f.job.streamId))?.createdAt).toBe(successor.createdAt);
    expect((await f.store.getJob(f.job.streamId))?.scheduleOutcomeError).toBeUndefined();
  } finally {
    await connection?.dispose().catch(() => undefined);
    await cleanupMCPRequestContext(context);
    MCPConnection.clearCooldown('Files');
    await server.close();
    await f.close();
  }
}, 30_000);

it.each(['root', 'child'])(
  "withholds an accepted B2 bearer's A3 denial from %s ToolNode until durable admission",
  async (agentId) => {
    const f = await fixture();
    const provider = jest.fn(async () => 'Should not execute');
    const server = await createOAuthMCPServer({ echoHandler: provider });
    const context = createMCPRequestContext();
    const manager = new MCPManager();
    const user = { id: f.owner, role: 'USER' } as IUser;
    const flowManager = new FlowStateManager<MCPOAuthTokens | null>(new Keyv(), {
      ci: true,
      ttl: 30_000,
    });
    let available = false;
    let resultReturned = false;
    let pending: Promise<unknown> | undefined;
    const registry = jest.spyOn(MCPServersRegistry, 'getInstance').mockReturnValue({
      isAppServerConfig: async () => false,
      resolveAllowlists: async () => ({
        allowedDomains: ['127.0.0.1'],
        allowedAddresses: [`127.0.0.1:${server.port}`],
        useSSRFProtection: false,
      }),
    } as unknown as MCPServersRegistry);
    try {
      const definition: ParsedServerConfig = {
        type: 'streamable-http',
        url: server.url,
        requiresOAuth: false,
        source: 'yaml',
        headers: { Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}' },
      };
      const policy: Record<string, ScheduledMCPReadOnlyPolicy> = {
        Files: { tools: { echo: { effect: 'read_only', definitionSha256: '0'.repeat(64) } } },
      };
      const target: ScheduledMCPTarget = {
        resource: {
          serverName: 'Files',
          url: server.url,
          credentialMode: 'resource_bearer',
          issuer: 'https://issuer.test/',
          audience: 'files',
          scopes: ['read'],
          configurationRevision: '',
        },
        permittedTools: [
          { agentId: 'root', tools: ['echo'] },
          { agentId: 'child', tools: ['echo'] },
        ],
        policyRevision: '',
      };
      target.resource.configurationRevision = getScheduledMCPConfigurationRevision(
        definition,
        target.resource,
      );
      target.policyRevision = getScheduledMCPPolicyRevision(target.permittedTools, policy.Files);
      const resolveEnrollment = async () => structuredClone([target]);
      const consent = createScheduleMCPConsentService({
        storage: f.methods,
        resolveEnrollment,
        getLimits: async () => ({ enabled: true, maxLifetimeHours: 24 }),
        canUse: async () => true,
        checkToolPolicy: async () => true,
      });
      const offer = await consent.view(f.identity);
      await consent.confirm(f.identity, {
        offerDigest: offer.offer!.digest,
        expectedRevision: offer.revision,
        lifetimeHours: 1,
      });
      const bearer = jest.fn(
        async (): Promise<ScheduledMCPBearerResult> => ({
          state: 'ready',
          accessToken: 'policy-only',
          expiresAtMs: Date.now() + 60_000,
          issuer: target.resource.issuer!,
          audience: target.resource.audience!,
          resourceUrl: server.url,
        }),
      );
      attachScheduledMCPBearer(
        context,
        f.identity,
        createScheduledMCPBearerHost({
          authority: consent.authority,
          resolveEnrollment,
          resolveBearer: bearer,
        }),
      );
      await createScheduleMCPExecution({
        storage: f.methods,
        loadAuthorization: async () => ({ authority: consent.authority, policy }),
      }).attach(context, f.identity, 'invoke', true);
      server.issuedTokens.add('policy-only');
      server.tokenIssueTimes.set('policy-only', Date.now());
      const persist = f.service.engineDeps.methods.recordMCPToolAuthFailure;
      const writes = jest
        .spyOn(f.service.engineDeps.methods, 'recordMCPToolAuthFailure')
        .mockImplementation(async (input) => {
          if (!available) throw new Error('Receipt storage unavailable');
          return persist(input);
        });
      let failure: unknown;
      const tool = new DynamicStructuredTool({
        name: 'echo_mcp_Files',
        description: 'Read',
        schema: z.object({}),
        func: async () => {
          try {
            return await manager.callTool({
              user,
              serverName: 'Files',
              serverConfig: definition,
              provider: 'openai',
              toolName: 'echo',
              toolArguments: { message: 'policy' },
              flowManager,
              requestScopedConnections: context,
              scheduledBearerInvocation: bindScheduledMCPBearerInvocation(context, agentId, 'echo'),
              scheduledMCPInvocation: bindScheduledMCPInvocation(context, agentId, 'echo'),
            });
          } catch (error) {
            failure = error;
            await recordScheduledMCPToolAuthFailure(
              {
                error,
                identity: f.identity,
                streamId: f.job.streamId,
                jobCreatedAt: f.job.createdAt,
                userId: f.owner,
                serverName: 'Files',
              },
              () => f.service.recordMCPToolAuthFailure,
            );
            throw error;
          }
        },
      });
      pending = new ToolNode({ agentId, tools: [tool] })
        .invoke(
          {
            messages: [
              new AIMessage({
                content: '',
                tool_calls: [{ id: 'policy', name: tool.name, args: {} }],
              }),
            ],
          },
          { configurable: { run_id: 'scheduled-policy', thread_id: f.job.streamId } },
        )
        .then((value) => {
          resultReturned = true;
          return value;
        });
      const deadline = Date.now() + 3000;
      while (writes.mock.calls.length === 0 && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(writes).toHaveBeenCalled();
      expect(bearer).toHaveBeenCalledTimes(1);
      expect(failure).toBeInstanceOf(ScheduledMCPPolicyError);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(resultReturned).toBe(false);
      expect(provider).not.toHaveBeenCalled();
      expect((await f.store.getJob(f.job.streamId))?.scheduleMCPFailure).toMatchObject({
        reason: 'tool_policy_denied',
        agentId,
      });
      expect(
        (await f.methods.getScheduleRunAbortState(f.schedule.id, f.scheduledFor))?.mcp,
      ).toBeUndefined();
      await expect(f.service.recordScheduleOutcome(f.outcome)).resolves.toBe(false);
      available = true;
      const result = await pending;
      expect(JSON.stringify(result)).toContain('tool_policy_denied');
      expect(await f.methods.getScheduleRunAbortState(f.schedule.id, f.scheduledFor)).toMatchObject(
        {
          status: 'started',
          mcp: [expect.objectContaining({ reason: 'tool_policy_denied', agentId })],
        },
      );
      await f.store.updateJob(
        f.job.streamId,
        { status: 'complete', completedAt: Date.now() },
        f.job.createdAt,
      );
      await expect(f.service.recordScheduleOutcome(f.outcome)).resolves.toBe(true);
      expect(await f.methods.getScheduleById(f.schedule.id)).toMatchObject({
        enabled: false,
        disabledReason: 'mcp_permission_denied',
        lastRun: { status: 'error' },
      });
    } finally {
      available = true;
      await pending?.catch(() => undefined);
      await cleanupMCPRequestContext(context);
      registry.mockRestore();
      MCPConnection.clearCooldown('Files');
      await server.close();
      await f.close();
    }
  },
  30_000,
);

it.each(['connect', 'SSE retry'] as const)(
  'cancels stalled %s bearer work before joining completion cleanup',
  async (mode) => {
    const f = await fixture();
    let dispatched = 0;
    const dispatchedMethods: string[] = [];
    const server = await createOAuthMCPServer({
      onResourceRequest: (req) => {
        if (req.method !== 'DELETE') {
          dispatched++;
          dispatchedMethods.push(req.method ?? 'unknown');
        }
      },
    });
    const context = createMCPRequestContext();
    let connection: MCPConnection | undefined;
    let slow = mode === 'connect';
    let released!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      released = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let captured: AbortSignal | undefined;
    const failures = jest.fn(async () => true);
    attachScheduledMCPBearer(
      context,
      f.identity,
      {
        bind: (identity, _stage, signal) => {
          captured = signal;
          return {
            identity,
            reject: () => {},
            resolve: async (input) => {
              if (slow) {
                entered();
                await gate;
              }
              return { ...input.config, headers: { Authorization: 'Bearer quiesce-only' } };
            },
          };
        },
      },
      'invoke',
      undefined,
      { onFailure: failures },
    );
    f.service.registerMCPSettlement({
      identity: f.identity,
      streamId: f.job.streamId,
      jobCreatedAt: f.job.createdAt,
      quiesce: () => quiesceMCPRequestContext(context),
    });
    server.issuedTokens.add('quiesce-only');
    server.tokenIssueTimes.set('quiesce-only', Date.now());
    const definition: ParsedServerConfig = {
      type: 'streamable-http',
      url: server.url,
      requiresOAuth: false,
      source: 'yaml',
      headers: { Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}' },
    };
    let stalled: Promise<unknown> | undefined;
    try {
      if (mode === 'connect') {
        stalled = MCPConnectionFactory.create(
          {
            serverName: 'Files',
            serverConfig: definition,
            ephemeralConnection: true,
            useSSRFProtection: false,
          },
          { user: { id: f.owner } as IUser, requestScopedConnections: context },
        );
        context.pending.set('Files', stalled);
      } else {
        connection = await MCPConnectionFactory.create(
          {
            serverName: 'Files',
            serverConfig: definition,
            ephemeralConnection: true,
            useSSRFProtection: false,
          },
          { user: { id: f.owner } as IUser, requestScopedConnections: context },
        );
        context.connections.set('Files', connection);
        const streamDeadline = Date.now() + 2000;
        while (!dispatchedMethods.includes('GET') && Date.now() < streamDeadline)
          await new Promise((resolve) => setTimeout(resolve, 10));
        expect(dispatchedMethods).toContain('GET');
        slow = true;
        const transport = Reflect.get(connection, 'transport');
        stalled = transport._startOrAuthSse({ resumptionToken: undefined });
      }
      const rejected = stalled!.catch((error) => error);
      await started;
      const before = dispatched;
      await f.store.updateJob(
        f.job.streamId,
        { status: 'complete', completedAt: Date.now() },
        f.job.createdAt,
      );
      const writes = jest.spyOn(f.service.engineDeps.methods, 'recordRunOutcome');
      const settlement = f.service.recordScheduleOutcome(f.outcome);
      const early = await Promise.race([
        settlement,
        new Promise<string>((resolve) => setTimeout(() => resolve('still waiting'), 100)),
      ]);
      const abortedBeforeRelease = captured?.aborted;
      released();
      await rejected;
      await settlement;
      expect(abortedBeforeRelease).toBe(true);
      expect(early).toBe(true);
      expect(writes).toHaveBeenCalledTimes(1);
      expect(dispatched).toBe(before);
      expect(failures).not.toHaveBeenCalled();
      expect(context.pending.size).toBe(0);
      expect(context.connections.size).toBe(0);
      expect(await f.methods.getScheduleRunAbortState(f.schedule.id, f.scheduledFor)).toMatchObject(
        { status: 'success' },
      );
      expect(await f.store.getJob(f.job.streamId)).toBeNull();
    } finally {
      released();
      await stalled?.catch(() => undefined);
      await connection?.dispose().catch(() => undefined);
      await cleanupMCPRequestContext(context);
      MCPConnection.clearCooldown('Files');
      await server.close();
      await f.close();
    }
  },
  30_000,
);

it.each(['cooperative', 'ignores abort'] as const)(
  'unwinds factory timeout before an initialize authorization host %s completes',
  async (mode) => {
    const f = await fixture();
    let dispatched = 0;
    const server = await createOAuthMCPServer({
      onResourceRequest: (req) => {
        if (req.method !== 'DELETE') dispatched++;
      },
    });
    const context = createMCPRequestContext();
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let waiterSignal: AbortSignal | undefined, ownerSignal: AbortSignal | undefined;
    let resolutions = 0;
    const failures = jest.fn(async () => true);
    const dispose = MCPConnection.prototype.dispose;
    const disposed: MCPConnection[] = [];
    const observing = jest
      .spyOn(MCPConnection.prototype, 'dispose')
      .mockImplementation(async function (this: MCPConnection) {
        disposed.push(this);
        return dispose.call(this);
      });
    const close = jest.spyOn(MCPConnection.prototype, 'disconnect');
    attachScheduledMCPBearer(
      context,
      f.identity,
      {
        bind: (identity, _stage, signal) => {
          ownerSignal = signal;
          return {
            identity,
            reject: () => {},
            resolve: async (input) => {
              if (++resolutions === 2) {
                waiterSignal = input.signal;
                entered();
                if (mode === 'ignores abort') await gate;
                else
                  await new Promise<void>((resolve, reject) => {
                    input.signal?.addEventListener('abort', () => reject(input.signal!.reason), {
                      once: true,
                    });
                    gate.then(resolve);
                  });
              }
              return { ...input.config, headers: { Authorization: 'Bearer init-waiter-only' } };
            },
          };
        },
      },
      'invoke',
      undefined,
      { onFailure: failures },
    );
    server.issuedTokens.add('init-waiter-only');
    server.tokenIssueTimes.set('init-waiter-only', Date.now());
    const definition: ParsedServerConfig = {
      type: 'streamable-http',
      url: server.url,
      initTimeout: 30,
      requiresOAuth: false,
      source: 'yaml',
      headers: { Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}' },
    };
    const pending = MCPConnectionFactory.create(
      {
        serverName: 'Files',
        serverConfig: definition,
        ephemeralConnection: true,
        useSSRFProtection: false,
      },
      { user: { id: f.owner } as IUser, requestScopedConnections: context },
    ).catch((error) => error);
    context.pending.set('failed-initialize', pending);
    let sibling: MCPConnection | undefined;
    try {
      await started;
      const outcome = await Promise.race([
        pending,
        new Promise<string>((resolve) => setTimeout(() => resolve('still waiting'), 250)),
      ]);
      const abortedBeforeRelease = waiterSignal?.aborted;
      release();
      await pending;
      expect(outcome).not.toBe('still waiting');
      expect(outcome).toMatchObject({ message: expect.stringContaining('timeout') });
      expect(abortedBeforeRelease).toBe(true);
      expect(ownerSignal?.aborted).toBe(false);
      expect(close).toHaveBeenCalled();
      expect(disposed).toHaveLength(1);
      expect(Reflect.get(disposed[0], 'pendingRequests').size).toBe(0);
      expect(Reflect.get(disposed[0], 'agents')).toHaveLength(0);
      expect(Reflect.get(disposed[0], 'transport')).toBeNull();
      expect(dispatched).toBe(0);
      expect(failures).not.toHaveBeenCalled();
      // Disposing one credential waiter cannot close the occurrence or sibling session.
      sibling = await MCPConnectionFactory.create(
        {
          serverName: 'Files',
          serverConfig: { ...definition, initTimeout: 1000 },
          ephemeralConnection: true,
          useSSRFProtection: false,
        },
        { user: { id: f.owner } as IUser, requestScopedConnections: context },
      );
      context.connections.set('sibling', sibling);
      await expect(sibling.fetchToolsSnapshot()).resolves.toMatchObject({ complete: true });
      expect(ownerSignal?.aborted).toBe(false);
      await f.store.updateJob(
        f.job.streamId,
        { status: 'error', completedAt: Date.now() },
        f.job.createdAt,
      );
      f.service.registerMCPSettlement({
        identity: f.identity,
        streamId: f.job.streamId,
        jobCreatedAt: f.job.createdAt,
        quiesce: () => quiesceMCPRequestContext(context),
      });
      await expect(
        f.service.recordScheduleOutcome({
          ...f.outcome,
          status: 'error',
          error: 'MCP initialize timed out',
        }),
      ).resolves.toBe(true);
      expect(
        (
          await f.database
            .model('ScheduleRun')
            .findOne({ scheduleId: f.schedule.id })
            .lean<IScheduleRun>()
        )?.capacitySlot,
      ).toBeUndefined();
      expect(await f.store.getJob(f.job.streamId)).toBeNull();
    } finally {
      release();
      await pending;
      await sibling?.dispose();
      observing.mockRestore();
      close.mockRestore();
      await cleanupMCPRequestContext(context);
      MCPConnection.clearCooldown('Files');
      await server.close();
      await f.close();
    }
  },
  30_000,
);

describe.each(['tool', 'App SDK read', 'App budget read'] as const)('%s admission', (phase) => {
  it.each(['authority denial', 'HTTP rejection', 'HTTP forbidden'] as const)(
    'keeps a known %s behind durable admission after the real SDK deadline',
    async (mode) => {
      const f = await fixture();
      let rejectTransport = false;
      const rejectionStatus = mode === 'HTTP forbidden' ? 403 : 401;
      const reason = {
        'authority denial': 'consent_revoked',
        'HTTP rejection': 'credential_rejected',
        'HTTP forbidden': 'resource_permission_denied',
      } as const;
      const server = await createOAuthMCPServer({
        ...(phase !== 'tool' && { appResourceUri: 'ui://admission' }),
        resourceFailure: () =>
          rejectTransport && mode !== 'authority denial' ? rejectionStatus : undefined,
      });
      const context = createMCPRequestContext();
      const manager = new MCPManager();
      const user = { id: f.owner, role: 'USER' } as IUser;
      const flowManager = new FlowStateManager<MCPOAuthTokens | null>(new Keyv(), {
        ci: true,
        ttl: 30_000,
      });
      let available = false,
        modelReturned = false;
      const failure = new ScheduledMCPBearerError(reason[mode], 'Files');
      const input = {
        error: failure,
        identity: f.identity,
        streamId: f.job.streamId,
        jobCreatedAt: f.job.createdAt,
        userId: f.owner,
        serverName: 'Files',
      };
      const record = jest.fn((error: ScheduledMCPBearerError) =>
        recordScheduledMCPToolAuthFailure(
          { ...input, error },
          () => f.service.recordMCPToolAuthFailure,
        ),
      );
      const registry = jest.spyOn(MCPServersRegistry, 'getInstance').mockReturnValue({
        isAppServerConfig: async () => false,
        resolveAllowlists: async () => ({
          allowedDomains: ['127.0.0.1'],
          allowedAddresses: [`127.0.0.1:${server.port}`],
          useSSRFProtection: false,
          mcpApps: {
            enabled: true,
            legacyHtmlEnabled: true,
            operationLimits: DEFAULT_MCP_APP_OPERATION_LIMITS,
          },
        }),
      } as unknown as MCPServersRegistry);
      let outcome: Promise<unknown> | undefined;
      try {
        const persist = f.service.engineDeps.methods.recordMCPToolAuthFailure;
        jest
          .spyOn(f.service.engineDeps.methods, 'recordMCPToolAuthFailure')
          .mockImplementation(async (payload) => {
            if (!available) throw new Error('Receipt storage unavailable');
            return persist(payload);
          });
        attachScheduledMCPBearer(
          context,
          f.identity,
          {
            bind: (identity) => ({
              identity,
              reject: () => {},
              resolve: async (payload) => {
                if (payload.selection && phase === 'tool') rejectTransport = true;
                else if (rejectTransport && mode === 'authority denial') throw failure;
                return { ...payload.config, headers: { Authorization: 'Bearer sdk-denial-only' } };
              },
            }),
          },
          'invoke',
          undefined,
          { onFailure: record },
        );
        server.issuedTokens.add('sdk-denial-only');
        server.tokenIssueTimes.set('sdk-denial-only', Date.now());
        const definition: ParsedServerConfig = {
          type: 'streamable-http',
          url: server.url,
          requiresOAuth: false,
          source: 'yaml',
          headers: { Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}' },
        };
        const connection = await manager.getConnection({
          user,
          serverName: 'Files',
          serverConfig: definition,
          flowManager,
          requestScopedConnections: context,
          ...(phase !== 'tool' && { capabilityProfile: MCP_APPS_CAPABILITY_PROFILE }),
        });
        await connection.fetchToolsSnapshot();
        if (phase === 'App SDK read') connection.timeout = 40;
        let sdkTimeout: unknown;
        const request = connection.client.request.bind(connection.client);
        jest.spyOn(connection.client, 'request').mockImplementation((...args) => {
          if (phase !== 'tool' && args[0].method === 'resources/read') rejectTransport = true;
          return request(...args).catch((error) => {
            sdkTimeout = error;
            throw error;
          });
        });
        let delivered: unknown;
        const tool = new DynamicStructuredTool({
          name: 'echo_mcp_Files',
          description: 'Read',
          schema: z.object({}),
          func: async () => {
            try {
              return await manager.callTool({
                user,
                serverName: 'Files',
                serverConfig: definition,
                provider: 'openai',
                flowManager,
                toolName: 'echo',
                toolArguments: { message: 'denied' },
                requestScopedConnections: context,
                scheduledBearerInvocation: bindScheduledMCPBearerInvocation(
                  context,
                  'root',
                  'echo',
                ),
                options: { timeout: phase === 'tool' ? 40 : 2000, maxTotalTimeout: 2000 },
                mcpApps: {
                  enabled: phase !== 'tool',
                  legacyHtmlEnabled: true,
                  operationLimits: {
                    ...DEFAULT_MCP_APP_OPERATION_LIMITS,
                    timeoutMs: phase === 'App budget read' ? 40 : 200,
                  },
                },
              });
            } catch (error) {
              delivered = error;
              await recordScheduledMCPToolAuthFailure(
                { ...input, error },
                () => f.service.recordMCPToolAuthFailure,
              );
              throw error;
            }
          },
        });
        outcome = new ToolNode({ agentId: 'root', tools: [tool] })
          .invoke(
            {
              messages: [
                new AIMessage({
                  content: '',
                  tool_calls: [{ id: 'deadline', name: tool.name, args: {} }],
                }),
              ],
            },
            { configurable: { run_id: 'sdk-deadline', thread_id: f.job.streamId } },
          )
          .then((result) => {
            modelReturned = true;
            return result;
          });
        const deadline = Date.now() + 2000;
        while (!sdkTimeout && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 10));
        expect(sdkTimeout).toMatchObject({ code: -32001 });
        expect(record).toHaveBeenCalledWith(expect.objectContaining({ failure: failure.failure }));
        expect(modelReturned).toBe(false);
        expect((await f.store.getJob(f.job.streamId))?.scheduleMCPFailure).toMatchObject({
          reason: failure.failure.reason,
        });
        expect(
          (await f.methods.getScheduleRunAbortState(f.schedule.id, f.scheduledFor))?.mcp,
        ).toBeUndefined();
        available = true;
        await outcome;
        expect(delivered).toMatchObject({ failure: failure.failure });
        expect(
          await f.methods.getScheduleRunAbortState(f.schedule.id, f.scheduledFor),
        ).toMatchObject({
          mcp: failure.outcomes,
        });
      } finally {
        available = true;
        await outcome?.catch(() => undefined);
        await cleanupMCPRequestContext(context);
        registry.mockRestore();
        MCPConnection.clearCooldown('Files');
        await server.close();
        await f.close();
      }
    },
    30_000,
  );
});

it.each(['reused caller', 'creating caller', 'SDK deadline'] as const)(
  'isolates %s cutoff through the actual SDK send handoff',
  async (mode) => {
    const f = await fixture();
    const executed: string[] = [];
    const dispatched: string[] = [];
    const controller = new AbortController();
    const server = await createOAuthMCPServer({
      onRPCRequest: (method) => dispatched.push(method),
      echoHandler: async (message) => {
        executed.push(message);
        return message;
      },
    });
    const context = createMCPRequestContext();
    const manager = new MCPManager();
    const user = { id: f.owner, role: 'USER' } as IUser;
    const flowManager = new FlowStateManager<MCPOAuthTokens | null>(new Keyv(), {
      ci: true,
      ttl: 30_000,
    });
    let stall = false,
      held = false;
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const record = jest.fn(async () => true);
    const registry = jest.spyOn(MCPServersRegistry, 'getInstance').mockReturnValue({
      isAppServerConfig: async () => false,
      resolveAllowlists: async () => ({
        allowedDomains: ['127.0.0.1'],
        allowedAddresses: [`127.0.0.1:${server.port}`],
        useSSRFProtection: false,
      }),
    } as unknown as MCPServersRegistry);
    let cancelled: Promise<unknown> | undefined, sibling: Promise<unknown> | undefined;
    try {
      attachScheduledMCPBearer(
        context,
        f.identity,
        {
          bind: (identity) => ({
            identity,
            reject: () => {},
            resolve: async (payload) => {
              if (stall && !payload.selection && !held) {
                held = true;
                entered();
                await gate;
              }
              return { ...payload.config, headers: { Authorization: 'Bearer sdk-caller-only' } };
            },
          }),
        },
        'invoke',
        undefined,
        { onFailure: record },
      );
      server.issuedTokens.add('sdk-caller-only');
      server.tokenIssueTimes.set('sdk-caller-only', Date.now());
      const definition: ParsedServerConfig = {
        type: 'streamable-http',
        url: server.url,
        requiresOAuth: false,
        source: 'yaml',
        headers: { Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}' },
      };
      const connection = await manager.getConnection({
        user,
        serverName: 'Files',
        serverConfig: definition,
        flowManager,
        requestScopedConnections: context,
        signal: mode === 'creating caller' ? controller.signal : undefined,
      });
      await connection.fetchToolsSnapshot();
      const call = (message: string, signal?: AbortSignal) =>
        manager.callTool({
          user,
          serverName: 'Files',
          serverConfig: definition,
          provider: 'openai',
          flowManager,
          toolName: 'echo',
          toolArguments: { message },
          requestScopedConnections: context,
          scheduledBearerInvocation: bindScheduledMCPBearerInvocation(context, 'root', 'echo'),
          options: {
            signal,
            timeout: mode === 'SDK deadline' && message === 'cancelled-caller' ? 40 : 2000,
          },
        });
      const transport = Reflect.get(connection, 'transport');
      const send = transport.send.bind(transport);
      jest.spyOn(transport, 'send').mockImplementation((...args: unknown[]) => {
        const message = args[0] as {
          method?: string;
          params?: { arguments?: { message?: string } };
        };
        if (
          message.method === 'tools/call' &&
          message.params?.arguments?.message === 'cancelled-caller'
        )
          stall = true;
        return send(...args);
      });
      cancelled = call('cancelled-caller', controller.signal).catch((error) => error);
      await started;
      sibling = call('sibling-caller');
      if (mode !== 'SDK deadline') controller.abort();
      const cancelledError = await cancelled;
      expect(Reflect.get(cancelledError as object, 'code')).toBe(-32001);
      release();
      await sibling;
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(executed).toEqual(['sibling-caller']);
      expect(record).not.toHaveBeenCalled();
      expect(context.cleanupStarted).toBe(false);
      expect(context.connections.size).toBe(1);
      expect(Reflect.get(connection, 'shouldStopReconnecting')).toBe(false);
      await call('later-caller');
      expect(executed).toEqual(['sibling-caller', 'later-caller']);
      expect(dispatched).not.toContain('notifications/cancelled');
    } finally {
      release();
      await cancelled;
      await sibling?.catch(() => undefined);
      await cleanupMCPRequestContext(context);
      registry.mockRestore();
      MCPConnection.clearCooldown('Files');
      await server.close();
      await f.close();
    }
  },
  30_000,
);

redisDescribe('retained creation recovery across worker loss', () => {
  it('repairs a retained creation from its durable Mongo run after the creator exits before indexing', async () => {
    const redis = new Redis({ path: process.env.B2_REDIS_SOCKET!, lazyConnect: true });
    await redis.connect();
    const f = await fixture(new RedisJobStore(redis, { runningTtl: 1 }), true);
    let worker: ReturnType<typeof spawn> | undefined;
    try {
      await f.store.deleteJob(f.job.streamId, f.job.createdAt);
      const metadata = {
        preserveForScheduleReconcile: true,
        providerExecutionId: 'unexposed-provider',
        scheduleId: f.schedule.id,
        scheduledFor: f.scheduledFor.toISOString(),
        agent_id: 'root',
      };
      worker = spawn(
        process.execPath,
        [
          '-e',
          `const Redis=require('ioredis');const {RedisJobStore}=require('./dist/index.cjs');
        const redis=new Redis({path:process.argv[1]});const store=new RedisJobStore(redis,{runningTtl:1});
        store.reconcileJobMembership=async()=>{process.stdout.write('committed\\n');await new Promise(()=>{});};
        store.createJob(process.argv[2],process.argv[3],process.argv[2],undefined,JSON.parse(process.argv[4])).catch(()=>process.exit(2));
        setInterval(()=>{},1000);`,
          process.env.B2_REDIS_SOCKET!,
          f.job.streamId,
          f.owner,
          JSON.stringify(metadata),
        ],
        { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
      );
      await new Promise<void>((resolve, reject) => {
        worker!.stdout!.once('data', () => resolve());
        worker!.once('error', reject);
        worker!.once('exit', () => reject(new Error('Creator failed before commit')));
      });
      const hash = await redis.hgetall(`stream:{${f.job.streamId}}:job`);
      expect(hash).toMatchObject({ status: 'running', preserveForScheduleReconcile: '1' });
      const member = JSON.stringify([f.job.streamId, Number(hash.createdAt)]);
      expect(await redis.sismember('stream:schedule_reconcile:v1', member)).toBe(0);
      const exited = once(worker, 'exit');
      worker.kill('SIGKILL');
      await exited;
      // The owning Mongo occurrence names this exact conversation before generation creation.
      expect(
        await f.database.models.ScheduleRun.findOne({
          scheduleId: f.schedule.id,
          scheduledFor: f.scheduledFor,
        }).lean(),
      ).toMatchObject({ status: 'started', conversationId: f.job.streamId });
      const restarted = new RedisJobStore(redis, { runningTtl: 1 });
      expect(await restarted.getJob(f.job.streamId)).toMatchObject({
        createdAt: Number(hash.createdAt),
        preserveForScheduleReconcile: true,
      });
      expect(await redis.sismember('stream:schedule_reconcile:v1', member)).toBe(1);
      expect(await redis.hget(`stream:{${f.job.streamId}}:job`, '__scheduleMembershipEpoch')).toBe(
        hash.createdAt,
      );
      await redis.hset(`stream:{${f.job.streamId}}:job`, 'lastActiveAt', String(Date.now() - 5000));
      await f.service.reconcileRetainedJobs();
      expect(await f.methods.getScheduleRunAbortState(f.schedule.id, f.scheduledFor)).toMatchObject(
        { status: 'error' },
      );
      expect(await f.store.getJob(f.job.streamId)).toBeNull();
    } finally {
      if (worker && worker.exitCode == null && worker.signalCode == null) {
        const exited = once(worker, 'exit');
        worker.kill('SIGKILL');
        await exited;
      }
      await f.close();
      await redis.quit();
    }
  }, 30_000);
});

describe.each(['preparation', 'initialization'] as const)('%s ownership', (phase) => {
  it.each(['creator', 'follower'] as const)(
    'isolates %s cancellation during cold scheduled connection acquisition',
    async (cancelledCaller) => {
      const f = await fixture();
      const server = await createOAuthMCPServer();
      const context = createMCPRequestContext();
      const manager = new MCPManager();
      const user = { id: f.owner, role: 'USER' } as IUser;
      const flowManager = new FlowStateManager<MCPOAuthTokens | null>(new Keyv(), {
        ci: true,
        ttl: 30_000,
      });
      const creator = new AbortController(),
        follower = new AbortController();
      let release!: () => void, entered!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const started = new Promise<void>((r) => {
        entered = r;
      });
      let stall = phase === 'preparation',
        held = false;
      let sharedSignal: AbortSignal | undefined;
      const failures = jest.fn(async () => true);
      const registry = jest.spyOn(MCPServersRegistry, 'getInstance').mockReturnValue({
        isAppServerConfig: async () => false,
        resolveAllowlists: async () => ({
          allowedDomains: ['127.0.0.1'],
          allowedAddresses: [`127.0.0.1:${server.port}`],
          useSSRFProtection: false,
        }),
      } as unknown as MCPServersRegistry);
      const connect = MCPConnection.prototype.connect;
      jest.spyOn(MCPConnection.prototype, 'connect').mockImplementation(function (
        this: MCPConnection,
        ...args
      ) {
        if (phase === 'initialization') stall = true;
        return connect.apply(this, args);
      });
      let first: Promise<unknown> | undefined,
        second: Promise<unknown> | undefined,
        third: Promise<MCPConnection> | undefined;
      try {
        attachScheduledMCPBearer(
          context,
          f.identity,
          {
            bind: (identity) => ({
              identity,
              reject: () => {},
              resolve: async (payload) => {
                if (stall && !held) {
                  held = true;
                  sharedSignal = payload.signal;
                  entered();
                  await gate;
                }
                return { ...payload.config, headers: { Authorization: 'Bearer cold-only' } };
              },
            }),
          },
          'invoke',
          undefined,
          { onFailure: failures },
        );
        server.issuedTokens.add('cold-only');
        server.tokenIssueTimes.set('cold-only', Date.now());
        const definition: ParsedServerConfig = {
          type: 'streamable-http',
          url: server.url,
          requiresOAuth: false,
          source: 'yaml',
          headers: { Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}' },
        };
        const acquire = (signal?: AbortSignal) =>
          manager.getConnection({
            user,
            serverName: 'Files',
            serverConfig: definition,
            flowManager,
            requestScopedConnections: context,
            signal,
          });
        first = acquire(creator.signal).catch((e) => e);
        await started;
        second = acquire(follower.signal).catch((e) => e);
        third = acquire();
        await new Promise((r) => setImmediate(r));
        expect(context.pending.size).toBe(1);
        const cancelled = cancelledCaller === 'creator' ? first : second;
        (cancelledCaller === 'creator' ? creator : follower).abort();
        const cancellationResult = await Promise.race([
          cancelled,
          new Promise((r) => setTimeout(() => r('still waiting'), 100)),
        ]);
        expect(cancellationResult).not.toBe('still waiting');
        expect(Reflect.get(cancellationResult as object, 'name')).toBe('AbortError');
        expect(sharedSignal?.aborted).toBe(false);
        expect(context.pending.size).toBe(1);
        release();
        const connection = await third;
        expect(await (cancelledCaller === 'creator' ? second : first)).toBe(connection);
        expect(await acquire()).toBe(connection);
        expect(context.connections.size).toBe(1);
        expect(context.pending.size).toBe(0);
        expect(failures).not.toHaveBeenCalled();
      } finally {
        release();
        await first;
        await second;
        await third?.catch(() => undefined);
        await cleanupMCPRequestContext(context);
        registry.mockRestore();
        MCPConnection.clearCooldown('Files');
        await server.close();
        await f.close();
      }
    },
    30_000,
  );
});

describe.each(['authority', 'provider'] as const)('%s observation', (source) => {
  it.each(['caller', 'occurrence'] as const)(
    'retains an observed denial when %s cancellation wins its promise handoff',
    async (cutoff) => {
      const f = await fixture();
      const server = await createOAuthMCPServer();
      const context = createMCPRequestContext();
      const manager = new MCPManager();
      const user = { id: f.owner, role: 'USER' } as IUser;
      const controller = new AbortController();
      const flowManager = new FlowStateManager<MCPOAuthTokens | null>(new Keyv(), {
        ci: true,
        ttl: 30_000,
      });
      let deny = false,
        available = false,
        observed = false,
        returned = false;
      let closing: Promise<void> | undefined;
      const failure = new ScheduledMCPBearerError('consent_revoked', 'Files');
      let time = Date.now();
      const observedFailure = {
        ...failure.failure,
        get reason() {
          observed = true;
          queueMicrotask(() => {
            if (cutoff === 'caller') controller.abort();
            else closing = quiesceMCPRequestContext(context);
          });
          return 'consent_revoked' as const;
        },
      };
      const definition: ParsedServerConfig = {
        type: 'streamable-http',
        url: server.url,
        source: 'yaml',
        requiresOAuth: false,
        headers: { Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}' },
      };
      const target: ScheduledMCPTarget = {
        resource: {
          serverName: 'Files',
          url: server.url,
          credentialMode: 'resource_bearer',
          issuer: 'https://issuer.test/',
          audience: 'files',
          scopes: ['read'],
          configurationRevision: '',
        },
        permittedTools: [{ agentId: 'root', tools: ['echo'] }],
        policyRevision: 'read-only',
      };
      target.resource.configurationRevision = getScheduledMCPConfigurationRevision(
        definition,
        target.resource,
      );
      const record = jest.fn((error: ScheduledMCPBearerError) =>
        recordScheduledMCPToolAuthFailure(
          {
            error,
            identity: f.identity,
            streamId: f.job.streamId,
            jobCreatedAt: f.job.createdAt,
            userId: f.owner,
            serverName: 'Files',
          },
          () => f.service.recordMCPToolAuthFailure,
        ),
      );
      const registry = jest.spyOn(MCPServersRegistry, 'getInstance').mockReturnValue({
        isAppServerConfig: async () => false,
        resolveAllowlists: async () => ({
          allowedDomains: ['127.0.0.1'],
          allowedAddresses: [`127.0.0.1:${server.port}`],
          useSSRFProtection: false,
        }),
      } as unknown as MCPServersRegistry);
      let request: Promise<unknown> | undefined;
      try {
        const persist = f.service.engineDeps.methods.recordMCPToolAuthFailure;
        jest
          .spyOn(f.service.engineDeps.methods, 'recordMCPToolAuthFailure')
          .mockImplementation(async (input) => {
            if (!available) throw new Error('Receipt storage unavailable');
            return persist(input);
          });
        attachScheduledMCPBearer(
          context,
          f.identity,
          createScheduledMCPBearerHost({
            resolveEnrollment: async () => [target],
            now: () => time,
            resolveBearer: async () =>
              deny && source === 'provider'
                ? { state: 'denied', failure: observedFailure }
                : {
                    state: 'ready',
                    accessToken: 'observed-only',
                    expiresAtMs: time + 10_000,
                    issuer: target.resource.issuer!,
                    audience: target.resource.audience!,
                    resourceUrl: server.url,
                  },
            authority: {
              lookupConsent: async () => ({ state: 'missing' }),
              authorize: async () =>
                deny && source === 'authority'
                  ? { state: 'denied', failure: observedFailure }
                  : {
                      state: 'authorized',
                      consentId: 'consent',
                      consentRevision: 'revision',
                      policyRevision: 'read-only',
                      validUntilMs: Date.now() + 60_000,
                    },
            },
          }),
          'invoke',
          undefined,
          { onFailure: record },
        );
        server.issuedTokens.add('observed-only');
        server.tokenIssueTimes.set('observed-only', Date.now());
        const connection = await manager.getConnection({
          user,
          serverName: 'Files',
          serverConfig: definition,
          flowManager,
          requestScopedConnections: context,
        });
        await connection.fetchToolsSnapshot();
        const transport = Reflect.get(connection, 'transport');
        const send = transport.send.bind(transport);
        jest.spyOn(transport, 'send').mockImplementation((...args: unknown[]) => {
          if ((args[0] as { method?: string }).method === 'tools/call') {
            deny = true;
            time += 20_000;
          }
          return send(...args);
        });
        request = manager
          .callTool({
            user,
            serverName: 'Files',
            serverConfig: definition,
            provider: 'openai',
            flowManager,
            toolName: 'echo',
            toolArguments: { message: 'withheld' },
            requestScopedConnections: context,
            scheduledBearerInvocation: bindScheduledMCPBearerInvocation(context, 'root', 'echo'),
            options: { signal: controller.signal, timeout: 1000 },
          })
          .catch((error) => error)
          .then((value) => {
            returned = true;
            return value;
          });
        const deadline = Date.now() + 2000;
        while (!observed && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
        expect(observed).toBe(true);
        await new Promise((r) => setTimeout(r, 30));
        expect(record).toHaveBeenCalledWith(expect.objectContaining({ failure: failure.failure }));
        expect(returned).toBe(false);
        expect((await f.store.getJob(f.job.streamId))?.scheduleMCPFailure).toMatchObject({
          reason: 'consent_revoked',
        });
        expect(
          (await f.methods.getScheduleRunAbortState(f.schedule.id, f.scheduledFor))?.mcp,
        ).toBeUndefined();
        available = true;
        expect(await request).toMatchObject({ failure: failure.failure });
        await closing;
        expect(
          await f.methods.getScheduleRunAbortState(f.schedule.id, f.scheduledFor),
        ).toMatchObject({ mcp: failure.outcomes });
      } finally {
        available = true;
        await request;
        await closing?.catch(() => undefined);
        await cleanupMCPRequestContext(context);
        registry.mockRestore();
        MCPConnection.clearCooldown('Files');
        await server.close();
        await f.close();
      }
    },
    30_000,
  );
});

it('keeps reused checkout ping cancellation local without dispatching after the caller cutoff', async () => {
  const f = await fixture();
  const methods: string[] = [];
  const server = await createOAuthMCPServer({ onRPCRequest: (method) => methods.push(method) });
  const context = createMCPRequestContext();
  const manager = new MCPManager();
  const user = { id: f.owner, role: 'USER' } as IUser;
  const flowManager = new FlowStateManager<MCPOAuthTokens | null>(new Keyv(), {
    ci: true,
    ttl: 30_000,
  });
  const controller = new AbortController();
  let stall = false,
    held = false,
    release!: () => void,
    entered!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const failures = jest.fn(async () => true);
  const registry = jest.spyOn(MCPServersRegistry, 'getInstance').mockReturnValue({
    isAppServerConfig: async () => false,
    resolveAllowlists: async () => ({
      allowedDomains: ['127.0.0.1'],
      allowedAddresses: [`127.0.0.1:${server.port}`],
      useSSRFProtection: false,
    }),
  } as unknown as MCPServersRegistry);
  let pending: Promise<unknown> | undefined;
  try {
    attachScheduledMCPBearer(
      context,
      f.identity,
      {
        bind: (identity) => ({
          identity,
          reject: () => {},
          resolve: async (input) => {
            if (stall && !held) {
              held = true;
              entered();
              await gate;
            }
            return { ...input.config, headers: { Authorization: 'Bearer probe-only' } };
          },
        }),
      },
      'invoke',
      undefined,
      { onFailure: failures },
    );
    server.issuedTokens.add('probe-only');
    server.tokenIssueTimes.set('probe-only', Date.now());
    const config: ParsedServerConfig = {
      type: 'streamable-http',
      url: server.url,
      source: 'yaml',
      requiresOAuth: false,
      headers: { Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}' },
    };
    const acquire = (signal?: AbortSignal) =>
      manager.getConnection({
        user,
        serverName: 'Files',
        serverConfig: config,
        flowManager,
        requestScopedConnections: context,
        signal,
      });
    const connection = await acquire();
    await connection.fetchToolsSnapshot();
    Reflect.set(connection, 'lastConnectionCheckAt', 0);
    const before = methods.length;
    stall = true;
    pending = acquire(controller.signal).catch((error) => error);
    await started;
    controller.abort();
    release();
    const result = await pending;
    await new Promise((r) => setTimeout(r, 30));
    expect(methods.slice(before)).toEqual([]);
    expect(Reflect.get(result as object, 'name')).toBe('AbortError');
    expect(context.connections.size).toBe(1);
    expect(await acquire()).toBe(connection);
    expect(failures).not.toHaveBeenCalled();
  } finally {
    release();
    await pending;
    await cleanupMCPRequestContext(context);
    registry.mockRestore();
    MCPConnection.clearCooldown('Files');
    await server.close();
    await f.close();
  }
}, 30_000);
