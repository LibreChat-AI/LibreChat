import Redis from 'ioredis';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { readScheduleMCPReceipts } from 'librechat-data-provider';
import type { IJobStoreV2 } from '~/stream/interfaces/IJobStore';
import { InMemoryJobStore } from '~/stream/implementations/InMemoryJobStore';
import { RedisJobStore } from '~/stream/implementations/RedisJobStore';

const denial = {
  server: 'Files',
  status: 'mcp_reauth_required' as const,
  reason: 'consent_revoked' as const,
  recovery: 'authorize' as const,
  automaticReplay: false as const,
  detail: 'unattended_auth_required' as const,
};
const encoded = `mcp_reauth_required: ${JSON.stringify([denial])}`;

async function verify(store: IJobStoreV2): Promise<string> {
  const stream = `receipt-${Date.now()}`;
  const created = await store.createJob(stream, 'owner', 'conversation', 'tenant');
  await store.updateJob(
    stream,
    { scheduleOutcome: 'error', scheduleOutcomeError: encoded },
    created.createdAt,
  );
  await store.updateJob(
    stream,
    { scheduleOutcome: 'success', scheduleOutcomeError: 'completed' },
    created.createdAt,
  );
  expect(readScheduleMCPReceipts((await store.getJob(stream))?.scheduleOutcomeError)).toEqual([
    denial,
  ]);
  await store.transitionStatus(stream, {
    from: 'running',
    to: 'requires_action',
    expectCreatedAt: created.createdAt,
    patch: { scheduleOutcome: 'interrupted', scheduleOutcomeError: 'Schedule deleted' },
  });
  expect((await store.getJob(stream))?.scheduleOutcome).toBe('error');
  expect(readScheduleMCPReceipts((await store.getJob(stream))?.scheduleOutcomeError)).toEqual([
    denial,
  ]);
  const other = {
    ...denial,
    server: 'Warehouse',
    status: 'mcp_permission_denied' as const,
    reason: 'tool_policy_denied' as const,
    recovery: 'restore_permission' as const,
  };
  await store.updateJob(
    stream,
    { scheduleOutcomeError: `mcp_permission_denied: ${JSON.stringify([other])}` },
    created.createdAt,
  );
  expect(readScheduleMCPReceipts((await store.getJob(stream))?.scheduleOutcomeError)).toEqual(
    expect.arrayContaining([denial, other]),
  );
  await store.transitionStatus(stream, {
    from: 'requires_action',
    to: 'error',
    expectCreatedAt: created.createdAt,
    clear: ['scheduleOutcome', 'scheduleOutcomeError'],
  });
  expect(readScheduleMCPReceipts((await store.getJob(stream))?.scheduleOutcomeError)).toEqual(
    expect.arrayContaining([denial, other]),
  );
  const policy = {
    server: 'Policy',
    agentId: 'child',
    status: 'mcp_permission_denied' as const,
    reason: 'tool_policy_denied' as const,
    recovery: 'configure' as const,
    automaticReplay: false as const,
  };
  const mixed = [denial, other, policy];
  await store.updateJob(
    stream,
    {
      scheduleMCPFailure: policy,
      scheduleOutcomeError: `mcp_permission_denied: ${JSON.stringify(mixed)}`,
    },
    created.createdAt,
  );
  await store.updateJob(
    stream,
    { scheduleMCPFailure: denial, scheduleOutcomeError: encoded },
    created.createdAt,
  );
  expect(readScheduleMCPReceipts((await store.getJob(stream))?.scheduleOutcomeError)).toEqual(
    expect.arrayContaining(mixed),
  );
  expect((await store.getJob(stream))?.scheduleMCPFailure).toEqual(policy);
  await store.updateJob(stream, { preserveForScheduleReconcile: true }, created.createdAt);
  await expect(store.createJob(stream, 'owner', 'conversation', 'tenant')).rejects.toMatchObject({
    name: 'JobPredecessorMismatchError',
  });
  expect((await store.getJob(stream))?.createdAt).toBe(created.createdAt);
  await store.updateJob(stream, { preserveForScheduleReconcile: false }, created.createdAt);
  await store.deleteJob(stream, created.createdAt);
  return stream;
}

it('retains all denial evidence under memory metadata/status writes and clears', async () => {
  const store = new InMemoryJobStore();
  const stream = await verify(store);
  await expect(store.getJob(stream)).resolves.toBeNull();
});
const redisDescribe = process.env.B2_REDIS_SOCKET ? describe : describe.skip;
redisDescribe('real Redis receipt retention', () => {
  it('retains a Redis-only receipt beyond terminal TTL until epoch-fenced acknowledgement', async () => {
    const redis = new Redis({ path: process.env.B2_REDIS_SOCKET!, lazyConnect: true });
    await redis.connect();
    const store = new RedisJobStore(redis, { completedTtl: 1 });
    const created = await store.createJob('retained-receipt', 'owner');
    try {
      await store.updateJob(
        'retained-receipt',
        { preserveForScheduleReconcile: true, scheduleOutcomeError: encoded },
        created.createdAt,
      );
      await store.transitionStatus('retained-receipt', {
        from: 'running',
        to: 'complete',
        expectCreatedAt: created.createdAt,
        patch: { completedAt: Date.now() },
      });
      expect(await redis.ttl('stream:{retained-receipt}:job')).toBe(-1);
      await new Promise((resolve) => setTimeout(resolve, 1100));
      expect((await store.getJob('retained-receipt'))?.scheduleOutcomeError).toContain(
        'consent_revoked',
      );
      await store.updateJob('retained-receipt', { status: 'complete' }, created.createdAt);
      await store.clearTerminalHostAction('retained-receipt', created.createdAt);
      expect(await redis.ttl('stream:{retained-receipt}:job')).toBe(-1);
      await store.updateJob(
        'retained-receipt',
        { preserveForScheduleReconcile: false },
        created.createdAt - 1,
      );
      expect(await redis.ttl('stream:{retained-receipt}:job')).toBe(-1);
      await store.updateJob(
        'retained-receipt',
        { preserveForScheduleReconcile: false },
        created.createdAt,
      );
      expect(await redis.ttl('stream:{retained-receipt}:job')).toBeGreaterThanOrEqual(0);
      expect(
        await redis.sismember(
          'stream:schedule_reconcile:v1',
          JSON.stringify(['retained-receipt', created.createdAt]),
        ),
      ).toBe(0);
    } finally {
      await store.deleteJob('retained-receipt', created.createdAt);
      await redis.quit();
    }
  });

  it.each(['update', 'transition'] as const)(
    'retires failed same-epoch %s pre-arms without erasing a successful re-arm',
    async (mode) => {
      const redis = new Redis({ path: process.env.B2_REDIS_SOCKET!, lazyConnect: true });
      await redis.connect();
      const store = new RedisJobStore(redis);
      const stream = `failed-prearm-${mode}`;
      const job = await store.createJob(stream, 'owner');
      const member = JSON.stringify([stream, job.createdAt]);
      try {
        if (mode === 'update') {
          jest.spyOn(redis, 'eval').mockImplementationOnce(async () => {
            throw new Error('CAS unavailable');
          });
          await expect(
            store.updateJob(stream, { preserveForScheduleReconcile: true }, job.createdAt),
          ).rejects.toThrow();
          jest.mocked(redis.eval).mockRestore();
        } else {
          expect(
            await store.transitionStatus(stream, {
              from: 'requires_action',
              to: 'error',
              expectCreatedAt: job.createdAt,
              patch: { preserveForScheduleReconcile: true },
            }),
          ).toBe(false);
        }
        expect(await redis.sismember('stream:schedule_reconcile:v1', member)).toBe(1);
        await store.getScheduleReconcileJobs(100);
        expect(await redis.sismember('stream:schedule_reconcile:v1', member)).toBe(0);
        // A successful writer that crosses retirement must confirm its hint after CAS.
        await store.updateJob(stream, { preserveForScheduleReconcile: true }, job.createdAt);
        expect(await redis.sismember('stream:schedule_reconcile:v1', member)).toBe(1);
      } finally {
        jest.restoreAllMocks();
        await store.deleteJob(stream, job.createdAt);
        await redis.quit();
      }
    },
  );

  it('confirms a successful same-epoch CAS after its pre-arm is retired by an outbox scan', async () => {
    const redis = new Redis({ path: process.env.B2_REDIS_SOCKET!, lazyConnect: true });
    await redis.connect();
    const store = new RedisJobStore(redis);
    const stream = 'prearm-during-scan';
    const job = await store.createJob(stream, 'owner');
    const evaluate = redis.eval.bind(redis);
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const intercept = jest.spyOn(redis, 'eval').mockImplementationOnce(async (...args) => {
      entered();
      await gate;
      return evaluate(...args);
    });
    const writing = store.updateJob(stream, { preserveForScheduleReconcile: true }, job.createdAt);
    try {
      await started;
      await store.getScheduleReconcileJobs(100);
      expect(
        await redis.sismember(
          'stream:schedule_reconcile:v1',
          JSON.stringify([stream, job.createdAt]),
        ),
      ).toBe(0);
      release();
      await writing;
      expect((await store.getJob(stream))?.preserveForScheduleReconcile).toBe(true);
      expect(
        await redis.sismember(
          'stream:schedule_reconcile:v1',
          JSON.stringify([stream, job.createdAt]),
        ),
      ).toBe(1);
    } finally {
      release();
      await writing;
      intercept.mockRestore();
      await store.deleteJob(stream, job.createdAt);
      await redis.quit();
    }
  });

  it('indexes initial retention at the actual CAS epoch and preserves its hash lifetime', async () => {
    const redis = new Redis({ path: process.env.B2_REDIS_SOCKET!, lazyConnect: true });
    await redis.connect();
    const store = new RedisJobStore(redis, { runningTtl: 1 });
    const stream = 'initial-schedule-retention';
    const clock = jest.spyOn(Date, 'now').mockReturnValue(1000);
    let epoch: number | undefined;
    try {
      const old = await store.createJob(stream, 'owner');
      await store.deleteJob(stream, old.createdAt);
      const job = await store.createJob(stream, 'owner', stream, undefined, {
        scheduleId: 'scheduled',
        scheduledFor: '2026-10-04T00:00:00Z',
        preserveForScheduleReconcile: true,
        providerExecutionId: 'initial-segment',
      });
      epoch = job.createdAt;
      expect(epoch).toBeGreaterThan(old.createdAt);
      expect(
        await redis.sismember('stream:schedule_reconcile:v1', JSON.stringify([stream, epoch])),
      ).toBe(1);
      expect(
        await redis.sismember(
          'stream:schedule_reconcile:v1',
          JSON.stringify([stream, old.createdAt]),
        ),
      ).toBe(0);
      expect(await redis.ttl(`stream:{${stream}}:job`)).toBe(-1);
      expect(
        (await new RedisJobStore(redis).getScheduleReconcileJobs(100)).find(
          (item) => item.streamId === stream,
        ),
      ).toMatchObject({
        createdAt: epoch,
        preserveForScheduleReconcile: true,
        providerDrained: true,
      });
      await expect(
        store.createJob(stream, 'owner', stream, undefined, { preserveForScheduleReconcile: true }),
      ).rejects.toMatchObject({ name: 'JobPredecessorMismatchError' });
      expect(await redis.smembers('stream:schedule_reconcile:v1')).toEqual([
        JSON.stringify([stream, epoch]),
      ]);
    } finally {
      clock.mockRestore();
      await store.deleteJob(stream, epoch);
      await redis.quit();
    }
  });

  it('repairs initial-retention hints before stale cleanup removes running membership', async () => {
    const redis = new Redis({ path: process.env.B2_REDIS_SOCKET!, lazyConnect: true });
    await redis.connect();
    const store = new RedisJobStore(redis, { runningTtl: 1 });
    const stream = 'stale-initial-schedule';
    const job = await store.createJob(stream, 'owner', stream, undefined, {
      scheduleId: 'scheduled',
      scheduledFor: '2026-10-04T00:00:00Z',
      preserveForScheduleReconcile: true,
      providerExecutionId: 'initial-segment',
    });
    const member = JSON.stringify([stream, job.createdAt]);
    try {
      await store.beginProviderExecution(stream, job.createdAt, 'initial-segment');
      await redis.srem('stream:schedule_reconcile:v1', member);
      await redis.hset(`stream:{${stream}}:job`, 'lastActiveAt', String(Date.now() - 5000));
      const index = jest.spyOn(redis, 'sadd').mockRejectedValueOnce(new Error('Index unavailable'));
      await store.cleanup();
      expect((await store.getJob(stream))?.status).toBe('running');
      expect(await redis.sismember('stream:running', stream)).toBe(1);
      index.mockRestore();
      await store.cleanup();
      expect((await store.getJob(stream))?.status).toBe('error');
      expect(await redis.sismember('stream:schedule_reconcile:v1', member)).toBe(1);
      expect(
        (await new RedisJobStore(redis).getScheduleReconcileJobs(100)).find(
          (item) => item.streamId === stream,
        ),
      ).toMatchObject({ createdAt: job.createdAt, providerDrained: false });
    } finally {
      jest.restoreAllMocks();
      await store.deleteJob(stream, job.createdAt);
      await redis.quit();
    }
  });

  it('recovers stale owner evidence and indexes post-settlement release across store restarts', async () => {
    const redis = new Redis({ path: process.env.B2_REDIS_SOCKET!, lazyConnect: true });
    await redis.connect();
    const store = new RedisJobStore(redis, { runningTtl: 1 });
    const stream = 'schedule-outbox-crash';
    const job = await store.createJob(stream, 'owner', stream, undefined, {
      providerExecutionId: 'owner-segment',
    });
    try {
      await store.enqueueSteer(
        stream,
        { steerId: 'queued', userId: 'owner', text: 'next', createdAt: Date.now() },
        job.createdAt,
      );
      await store.updateJob(
        stream,
        {
          preserveForScheduleReconcile: true,
          scheduleOutcomeError: encoded,
          providerDrained: false,
        },
        job.createdAt,
      );
      await redis.hset(`stream:{${stream}}:job`, 'lastActiveAt', String(Date.now() - 5000));
      const restarted = new RedisJobStore(redis, { runningTtl: 1 });
      const held = await restarted.getScheduleReconcileJobs(100);
      expect(held.find((item) => item.streamId === stream)).toMatchObject({
        status: 'error',
        createdAt: job.createdAt,
        preserveForScheduleReconcile: true,
        providerDrained: false,
      });
      expect((await restarted.getJob(stream))?.scheduleOutcomeError).toContain('consent_revoked');
      expect(JSON.parse((await restarted.claimParkedSteers(stream, 'owner'))!).steers).toEqual(
        expect.arrayContaining([expect.objectContaining({ steerId: 'queued' })]),
      );
      await redis.hset(`stream:{${stream}}:job`, 'completedAt', String(Date.now() - 60_000));
      expect(
        (await restarted.getScheduleReconcileJobs(100)).find((item) => item.streamId === stream)
          ?.providerDrained,
      ).toBe(false);
      await expect(
        restarted.markProviderExecutionDrained(stream, job.createdAt, 'wrong-segment'),
      ).resolves.toBe(false);
      await expect(
        restarted.markProviderExecutionDrained(stream, job.createdAt, 'owner-segment'),
      ).resolves.toBe(true);
      // Mongo can already be bookkept. The job's obligation is still discoverable.
      expect(
        (await new RedisJobStore(redis).getScheduleReconcileJobs(100)).map((item) => item.streamId),
      ).toContain(stream);
      await restarted.updateJob(stream, { preserveForScheduleReconcile: false }, job.createdAt);
      await restarted.deleteJob(stream, job.createdAt);
      expect(
        await redis.sismember(
          'stream:schedule_reconcile:v1',
          JSON.stringify([stream, job.createdAt]),
        ),
      ).toBe(0);
      expect(
        (await restarted.getScheduleReconcileJobs(100)).map((item) => item.streamId),
      ).not.toContain(stream);
    } finally {
      await store.deleteJob(stream, job.createdAt);
      await redis.quit();
    }
  });

  it('retires exact deletion and status acknowledgements without removing a successor hint', async () => {
    const redis = new Redis({ path: process.env.B2_REDIS_SOCKET!, lazyConnect: true });
    await redis.connect();
    const store = new RedisJobStore(redis);
    const stream = 'hint-successor';
    try {
      const old = await store.createJob(stream, 'owner');
      await store.updateJob(stream, { preserveForScheduleReconcile: true }, old.createdAt);
      await store.deleteJob(stream, old.createdAt);
      expect(
        await redis.sismember(
          'stream:schedule_reconcile:v1',
          JSON.stringify([stream, old.createdAt]),
        ),
      ).toBe(0);
      const successor = await store.createJob(stream, 'owner');
      const member = JSON.stringify([stream, successor.createdAt]);
      await store.updateJob(stream, { preserveForScheduleReconcile: true }, successor.createdAt);
      await store.updateJob(stream, { preserveForScheduleReconcile: false }, old.createdAt);
      expect(await store.deleteJob(stream, old.createdAt)).toBe(false);
      expect(await redis.sismember('stream:schedule_reconcile:v1', member)).toBe(1);
      expect(
        await store.transitionStatus(stream, {
          from: 'running',
          to: 'complete',
          expectCreatedAt: successor.createdAt,
          patch: { completedAt: Date.now(), preserveForScheduleReconcile: false },
        }),
      ).toBe(true);
      expect(await redis.sismember('stream:schedule_reconcile:v1', member)).toBe(0);
      await store.deleteJob(stream, successor.createdAt);
    } finally {
      await store.deleteJob(stream);
      await redis.quit();
    }
  });

  it.each(['before hash', 'after hash'] as const)(
    'keeps a same-epoch retention re-arm racing release %s',
    async (phase) => {
      const redis = new Redis({ path: process.env.B2_REDIS_SOCKET!, lazyConnect: true });
      await redis.connect();
      const store = new RedisJobStore(redis);
      const stream = `hint-rearm-${phase}`;
      const job = await store.createJob(stream, 'owner');
      await store.updateJob(stream, { preserveForScheduleReconcile: true }, job.createdAt);
      try {
        if (phase === 'after hash') {
          const remove = redis.srem.bind(redis);
          jest.spyOn(redis, 'srem').mockImplementationOnce(async (...args) => {
            const result = await remove(...args);
            await store.updateJob(stream, { preserveForScheduleReconcile: true }, job.createdAt);
            return result;
          });
          await store.updateJob(stream, { preserveForScheduleReconcile: false }, job.createdAt);
        } else {
          let arrived!: () => void;
          const entered = new Promise<void>((resolve) => {
            arrived = resolve;
          });
          let release!: () => void;
          const gate = new Promise<void>((resolve) => {
            release = resolve;
          });
          const evaluate = redis.eval.bind(redis);
          jest.spyOn(redis, 'eval').mockImplementationOnce(async (...args) => {
            arrived();
            await gate;
            return evaluate(...args);
          });
          const retained = store.updateJob(
            stream,
            { preserveForScheduleReconcile: true },
            job.createdAt,
          );
          await entered;
          await store.updateJob(stream, { preserveForScheduleReconcile: false }, job.createdAt);
          release();
          await retained;
        }
        expect((await store.getJob(stream))?.preserveForScheduleReconcile).toBe(true);
        expect(
          await redis.sismember(
            'stream:schedule_reconcile:v1',
            JSON.stringify([stream, job.createdAt]),
          ),
        ).toBe(1);
        expect(await redis.ttl(`stream:{${stream}}:job`)).toBe(-1);
      } finally {
        jest.restoreAllMocks();
        await store.deleteJob(stream, job.createdAt);
        await redis.quit();
      }
    },
  );

  it('retains all denial evidence atomically in real Redis without affecting a replaced epoch', async () => {
    const redis = new Redis({ path: process.env.B2_REDIS_SOCKET!, lazyConnect: true });
    try {
      await redis.connect();
      const store = new RedisJobStore(redis);
      await verify(store);
      const old = await store.createJob('epoch-receipt', 'owner');
      await store.deleteJob('epoch-receipt', old.createdAt);
      const current = await store.createJob('epoch-receipt', 'owner');
      await store.updateJob('epoch-receipt', { scheduleOutcomeError: encoded }, old.createdAt);
      expect((await store.getJob('epoch-receipt'))?.scheduleOutcomeError).toBeUndefined();
      await store.deleteJob('epoch-receipt', current.createdAt);
    } finally {
      await redis.quit();
    }
  });
});

(process.env.B2_REDIS_SOCKET ? describe : describe.skip)('retention re-arm writer loss', () => {
  it.each(['update', 'transition'] as const)(
    'repairs %s discovery after the writer exits between CAS and confirmation',
    async (mode) => {
      const redis = new Redis({ path: process.env.B2_REDIS_SOCKET!, lazyConnect: true });
      await redis.connect();
      const store = new RedisJobStore(redis);
      const stream = `rearmed-writer-loss-${mode}`;
      const key = `stream:{${stream}}:job`;
      const job = await store.createJob(stream, 'owner', stream, undefined, {
        preserveForScheduleReconcile: true,
      });
      const member = JSON.stringify([stream, job.createdAt]);
      let worker: ReturnType<typeof spawn> | undefined;
      try {
        await store.transitionStatus(stream, {
          from: 'running',
          to: 'complete',
          expectCreatedAt: job.createdAt,
        });
        await store.getJob(stream);
        expect(await redis.hget(key, '__scheduleMembershipEpoch')).toBe(String(job.createdAt));
        await store.updateJob(stream, { preserveForScheduleReconcile: false }, job.createdAt);
        expect(await redis.sismember('stream:schedule_reconcile:v1', member)).toBe(0);
        worker = spawn(
          process.execPath,
          [
            '-e',
            `const Redis=require('ioredis');const {RedisJobStore}=require('./dist/index.cjs');
        const redis=new Redis({path:process.argv[1]});const store=new RedisJobStore(redis);
        const evaluate=redis.eval.bind(redis);let announced=false;
        redis.eval=async(...args)=>{const retain=args.slice(2).some((v,i,a)=>v==='preserveForScheduleReconcile'&&a[i+1]==='1');
          if(retain&&!announced){announced=true;process.stdout.write('prearm\\n');await new Promise(r=>process.stdin.once('data',r));
            await evaluate(...args);process.stdout.write('committed\\n');await new Promise(()=>{});}
          return evaluate(...args);};
        const id=process.argv[2],epoch=Number(process.argv[3]);
        const work=process.argv[4]==='update'?store.updateJob(id,{preserveForScheduleReconcile:true},epoch):
          store.transitionStatus(id,{from:'complete',to:'complete',expectCreatedAt:epoch,patch:{preserveForScheduleReconcile:true}});
        work.catch(()=>process.exit(2));setInterval(()=>{},1000);`,
            process.env.B2_REDIS_SOCKET!,
            stream,
            String(job.createdAt),
            mode,
          ],
          { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] },
        );
        const next = () =>
          new Promise<string>((resolve, reject) => {
            worker!.stdout!.once('data', (chunk) => resolve(chunk.toString()));
            worker!.once('error', reject);
            worker!.once('exit', () =>
              reject(new Error('Writer exited before the controlled commit')),
            );
          });
        expect(await next()).toContain('prearm');
        await new RedisJobStore(redis).getScheduleReconcileJobs(100);
        expect(await redis.sismember('stream:schedule_reconcile:v1', member)).toBe(0);
        const committed = next();
        worker.stdin!.write('commit');
        expect(await committed).toContain('committed');
        const exited = once(worker, 'exit');
        worker.kill('SIGKILL');
        await exited;
        expect(await redis.hget(key, 'preserveForScheduleReconcile')).toBe('1');
        expect(await redis.sismember('stream:schedule_reconcile:v1', member)).toBe(0);
        // A surviving exact-identity read must repair even though this epoch was confirmed before acknowledgement.
        const restarted = new RedisJobStore(redis);
        await restarted.getJob(stream);
        expect(await redis.sismember('stream:schedule_reconcile:v1', member)).toBe(1);
        expect(await restarted.getScheduleReconcileJobs(100)).toEqual([
          expect.objectContaining({ streamId: stream, createdAt: job.createdAt }),
        ]);
        expect(await redis.hget(key, '__scheduleMembershipEpoch')).toBe(String(job.createdAt));
        await restarted.updateJob(stream, { preserveForScheduleReconcile: false }, job.createdAt);
        expect(await restarted.createJob(stream, 'owner')).toMatchObject({ status: 'running' });
      } finally {
        if (worker && worker.exitCode == null && worker.signalCode == null) {
          const exited = once(worker, 'exit');
          worker.kill('SIGKILL');
          await exited;
        }
        await store.deleteJob(stream);
        await redis.quit();
      }
    },
    30_000,
  );
});
