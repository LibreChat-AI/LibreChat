import mongoose from 'mongoose';
import { EventEmitter } from 'events';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { logger, createModels, createMethods } from '@librechat/data-schemas';
import type { GenerationJobManagerClass } from '~/stream';
import {
  AssistantRun,
  getAssistantRun,
  withAssistantRun,
  enrollAssistantRun,
  unmanagedAssistantRun,
} from './run';
import { InMemoryEventTransport } from '~/stream/implementations/InMemoryEventTransport';
import { InMemoryJobStore } from '~/stream/implementations/InMemoryJobStore';
import { GenerationJobManagerClass as JobManager } from '~/stream';
import { stopUserGenerations } from '~/user/generations';

class FakeResponse extends EventEmitter {
  closed = false;
  destroyed = false;
  ended = false;
  statusCode = 200;
  body: unknown;

  end() {
    this.ended = true;
  }

  status(code: number) {
    this.statusCode = code;
    return this;
  }

  json(body: unknown) {
    this.body = body;
    return this;
  }

  close() {
    this.closed = true;
    this.emit('close');
  }
}

function createManager(): GenerationJobManagerClass {
  const manager = new JobManager();
  manager.configure({
    jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
    eventTransport: new InMemoryEventTransport(),
    cleanupOnComplete: false,
  });
  manager.initialize();
  return manager;
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

const closedResponse = () => {
  const res = new FakeResponse();
  res.close();
  return res;
};

describe('Assistants run enrollment', () => {
  let manager: GenerationJobManagerClass;
  let isPrincipalActive: jest.Mock<Promise<boolean>, [string]>;

  const enroll = () =>
    enrollAssistantRun(
      { userId: 'user-1', endpoint: 'assistants', assistantId: 'asst_1' },
      { manager, isPrincipalActive, responseCloseGraceMs: 20 },
    );

  beforeEach(() => {
    manager = createManager();
    isPrincipalActive = jest.fn().mockResolvedValue(true);
  });

  afterEach(async () => {
    await manager.destroy();
  });

  it('registers the run where the account drain looks, with provider work in flight', async () => {
    const run = await enroll();

    const [streamId] = await manager.getAccountCleanupJobIdsForUser('user-1');
    await expect(manager.getJobStore().getJob(streamId)).resolves.toMatchObject({
      userId: 'user-1',
      status: 'running',
      providerDrained: false,
      endpoint: 'assistants',
      model: 'asst_1',
    });
    expect(run.stopped).toBe(false);
  });

  it('gives each turn its own job', async () => {
    await enroll();
    await enroll();

    await expect(manager.getCleanupBlockingJobIdsForUser('user-1')).resolves.toHaveLength(2);
  });

  it('is reached by owner-wide drains but not by a single conversation delete', async () => {
    await enroll();

    await expect(manager.getCleanupBlockingJobIdsForUser('user-1')).resolves.toHaveLength(1);
    await expect(
      manager.getCleanupBlockingJobIdsForConversations('user-1', ['conversation-1']),
    ).resolves.toEqual([]);
  });

  it('refuses the run once the owner is being deleted and leaves nothing registered', async () => {
    isPrincipalActive.mockResolvedValue(false);

    await expect(enroll()).rejects.toMatchObject({
      code: 'ACCOUNT_DELETION_IN_PROGRESS',
      status: 409,
    });
    await expect(manager.getAccountCleanupJobIdsForUser('user-1')).resolves.toEqual([]);
  });

  it('reports a failed admission lookup as unavailable and leaves nothing registered', async () => {
    isPrincipalActive.mockRejectedValue(new Error('user store down'));

    await expect(enroll()).rejects.toMatchObject({
      code: 'GENERATION_ADMISSION_UNAVAILABLE',
      status: 503,
    });
    await expect(manager.getAccountCleanupJobIdsForUser('user-1')).resolves.toEqual([]);
  });

  describe('account deletion drain', () => {
    it('stops the run and holds erasure until its trailing writes landed', async () => {
      const order: string[] = [];
      const run = await enroll();
      const write = deferred();
      run.onStop(() => {
        order.push('cancelled');
      });
      run.track(
        write.promise.then(() => {
          order.push('trailing write');
        }),
      );

      const erasing = stopUserGenerations('user-1', undefined, manager).then(() => {
        order.push('erase');
      });
      await flush();
      expect(run.stopped).toBe(true);
      expect(order).toEqual(['cancelled']);

      write.resolve();
      await run.settle(closedResponse());
      await erasing;

      expect(order).toEqual(['cancelled', 'trailing write', 'erase']);
    });

    it('does not let erasure start while the controller is still running', async () => {
      const controller = deferred();
      const res = new FakeResponse();
      const handler = withAssistantRun(
        async (_req, response: FakeResponse) => {
          await controller.promise;
          response.close();
        },
        { manager, isPrincipalActive, responseCloseGraceMs: 20 },
      );
      const running = handler({ user: { id: 'user-1' }, body: {} }, res);
      await flush();

      let erased = false;
      const erasing = stopUserGenerations('user-1', undefined, manager).then(() => {
        erased = true;
      });
      await flush();
      expect(erased).toBe(false);

      controller.resolve();
      await running;
      await erasing;
      expect(erased).toBe(true);
    });

    it('cancels the provider run when the run is stopped', async () => {
      const run = await enroll();
      const cancel = jest.fn().mockResolvedValue({});
      const openai = { beta: { threads: { runs: { cancel } } } };
      run.cancelOnStop(openai, { thread_id: 'thread_1', run_id: 'run_1' });
      expect(cancel).not.toHaveBeenCalled();

      const stopping = stopUserGenerations('user-1', undefined, manager);
      await flush();
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(cancel).toHaveBeenCalledWith('run_1', { thread_id: 'thread_1' });

      await run.settle(closedResponse());
      await stopping;
    });

    it('cancels at once a provider run that was created after the stop', async () => {
      const run = await enroll();
      const stopping = stopUserGenerations('user-1', undefined, manager);
      await flush();

      const cancel = jest.fn().mockResolvedValue({});
      run.cancelOnStop(
        { beta: { threads: { runs: { cancel } } } },
        { thread_id: 't', run_id: 'r' },
      );
      await flush();
      expect(cancel).toHaveBeenCalledWith('r', { thread_id: 't' });

      await run.settle(closedResponse());
      await stopping;
    });

    it('raises the cancellation the error handlers recognize only once stopped', async () => {
      const run = await enroll();
      expect(() => run.throwIfStopped()).not.toThrow();

      const stopping = stopUserGenerations('user-1', undefined, manager);
      await flush();
      expect(() => run.throwIfStopped()).toThrow('Run cancelled');

      await run.settle(closedResponse());
      await stopping;
    });

    it('runs a cancel registered after the stop at once', async () => {
      const run = await enroll();
      const stopping = stopUserGenerations('user-1', undefined, manager);
      await flush();
      expect(run.stopped).toBe(true);

      const cancel = jest.fn();
      run.onStop(cancel);
      await flush();
      expect(cancel).toHaveBeenCalledTimes(1);

      await run.settle(closedResponse());
      await stopping;
    });

    it('contains a failing cancel', async () => {
      const run = await enroll();
      run.onStop(() => Promise.reject(new Error('provider unreachable')));
      const stopping = stopUserGenerations('user-1', undefined, manager);
      await flush();

      await run.settle(closedResponse());
      await expect(stopping).resolves.toBeUndefined();
    });
  });

  describe('track', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('waits for work that tracked work starts', async () => {
      const run = await enroll();
      const order: string[] = [];
      const inner = deferred();
      run.track(
        (async () => {
          await flush();
          run.track(
            inner.promise.then(() => {
              order.push('inner');
            }),
          );
          order.push('outer');
        })(),
      );

      const settled = run.settle(closedResponse()).then(() => {
        order.push('settled');
      });
      await flush();
      await flush();
      expect(order).toEqual(['outer']);

      inner.resolve();
      await settled;
      expect(order).toEqual(['outer', 'inner', 'settled']);
    });

    it('logs a failure and leaves the rejection to the caller', async () => {
      const run = await enroll();
      const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);

      const failing = run.track(Promise.reject(new Error('save failed')));

      await expect(failing).rejects.toThrow('save failed');
      await run.settle(closedResponse());
      expect(warn).toHaveBeenCalledWith('[AssistantRun] Tracked work failed', expect.anything());
    });

    it('lets work started after settlement run and says it is outside the drain', async () => {
      const run = await enroll();
      await run.settle(closedResponse());
      const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
      const late = Promise.resolve('late');

      expect(run.track(late)).toBe(late);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('after the run settled'));
    });
  });

  describe('guard', () => {
    it('runs the handler and makes settlement wait for it', async () => {
      const run = await enroll();
      const release = deferred();
      const finished = jest.fn();
      const guarded = run.guard(async () => {
        await release.promise;
        finished();
      });

      void guarded();
      const settled = run.settle(closedResponse());
      await flush();
      expect(finished).not.toHaveBeenCalled();
      await expect(manager.getCleanupBlockingJobIdsForUser('user-1')).resolves.toHaveLength(1);

      release.resolve();
      await settled;
      expect(finished).toHaveBeenCalledTimes(1);
      await expect(manager.getCleanupBlockingJobIdsForUser('user-1')).resolves.toEqual([]);
    });

    it('skips the handler for a stopped run', async () => {
      const run = await enroll();
      const handler = jest.fn().mockResolvedValue(undefined);
      const stopping = stopUserGenerations('user-1', undefined, manager);
      await flush();

      await run.guard(handler)();
      expect(handler).not.toHaveBeenCalled();

      await run.settle(closedResponse());
      await stopping;
    });

    it('skips a handler that fires while the job is still being completed', async () => {
      const run = await enroll();
      const completing = deferred();
      const completeJob = manager.completeJob.bind(manager);
      jest.spyOn(manager, 'completeJob').mockImplementation(async (...args) => {
        await completing.promise;
        return completeJob(...args);
      });
      const handler = jest.fn().mockResolvedValue(undefined);
      const guarded = run.guard(handler);

      const settled = run.settle(closedResponse());
      await flush();
      expect(run.stopped).toBe(false);
      await expect(guarded()).resolves.toBeUndefined();
      expect(handler).not.toHaveBeenCalled();

      completing.resolve();
      await settled;
    });

    it('skips a handler that fires after settlement without throwing', async () => {
      const run = await enroll();
      const handler = jest.fn().mockResolvedValue(undefined);
      const guarded = run.guard(handler);

      await run.settle(closedResponse());

      await expect(guarded()).resolves.toBeUndefined();
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('guardErrors', () => {
    it('hands the error to the handler while the run is live', async () => {
      const run = await enroll();
      const res = new FakeResponse();
      const handler = jest.fn().mockResolvedValue('handled');
      const error = new Error('provider failed');

      await expect(run.guardErrors(res, handler)(error)).resolves.toBe('handled');

      expect(handler).toHaveBeenCalledWith(error);
      expect(res.ended).toBe(false);
    });

    it('only ends the response for a stopped run', async () => {
      const run = await enroll();
      const res = new FakeResponse();
      const handler = jest.fn();
      const stopping = stopUserGenerations('user-1', undefined, manager);
      await flush();

      await run.guardErrors(res, handler)(new Error('provider failed'));

      expect(handler).not.toHaveBeenCalled();
      expect(res.ended).toBe(true);

      await run.settle(closedResponse());
      await stopping;
    });
  });

  describe('withAssistantRun', () => {
    const request = (body: unknown = { endpoint: 'assistants', assistant_id: 'asst_1' }) => ({
      user: { id: 'user-1' },
      body,
    });
    const deps = () => ({ manager, isPrincipalActive, responseCloseGraceMs: 20 });

    it('hands the controller its run and settles once the controller returned', async () => {
      const res = new FakeResponse();
      let seen: unknown;
      let blocking: string[] = [];
      const handler = withAssistantRun(async (req, response: FakeResponse) => {
        seen = req.assistantRun;
        blocking = await manager.getCleanupBlockingJobIdsForUser('user-1');
        response.close();
      }, deps());

      await handler(request(), res);

      expect(seen).toBeInstanceOf(AssistantRun);
      expect(blocking).toHaveLength(1);
      await expect(manager.getCleanupBlockingJobIdsForUser('user-1')).resolves.toEqual([]);
    });

    it('answers 409 and skips the controller while the account is being deleted', async () => {
      isPrincipalActive.mockResolvedValue(false);
      const controller = jest.fn();
      const res = new FakeResponse();

      await withAssistantRun(controller, deps())(request(), res);

      expect(controller).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(409);
      expect(res.body).toEqual({
        message: 'Account deletion is in progress',
        code: 'ACCOUNT_DELETION_IN_PROGRESS',
      });
    });

    it('answers 503 and skips the controller when admission cannot be verified', async () => {
      isPrincipalActive.mockRejectedValue(new Error('user store down'));
      const controller = jest.fn();
      const res = new FakeResponse();

      await withAssistantRun(controller, deps())(request(), res);

      expect(controller).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(503);
      expect(res.body).toEqual({
        message: 'Generation admission could not be verified',
        code: 'GENERATION_ADMISSION_UNAVAILABLE',
      });
    });

    it('keeps the run registered until the response closes', async () => {
      const res = new FakeResponse();
      const handler = withAssistantRun(async () => undefined, {
        ...deps(),
        responseCloseGraceMs: 5_000,
      });

      let done = false;
      const running = handler(request(), res).then(() => {
        done = true;
      });
      await flush();
      expect(done).toBe(false);
      await expect(manager.getCleanupBlockingJobIdsForUser('user-1')).resolves.toHaveLength(1);

      res.close();
      await running;
      await expect(manager.getCleanupBlockingJobIdsForUser('user-1')).resolves.toEqual([]);
    });

    it('settles and rethrows when the controller fails', async () => {
      const res = closedResponse();
      const handler = withAssistantRun(async () => {
        throw new Error('controller failed');
      }, deps());

      await expect(handler(request(), res)).rejects.toThrow('controller failed');
      await expect(manager.getCleanupBlockingJobIdsForUser('user-1')).resolves.toEqual([]);
    });

    it('names the run after the endpoint and assistant of the request', async () => {
      const res = closedResponse();
      const handler = withAssistantRun(async () => {
        const [streamId] = await manager.getCleanupBlockingJobIdsForUser('user-1');
        expect(await manager.getJobStore().getJob(streamId)).toMatchObject({
          endpoint: 'azureAssistants',
          model: 'asst_9',
        });
      }, deps());

      await handler(request({ endpoint: 'azureAssistants', assistant_id: 'asst_9' }), res);
    });
  });
});

describe('getAssistantRun', () => {
  it('returns the run a route enrolled for the request, and an unmanaged one otherwise', async () => {
    const manager = createManager();
    try {
      const run = await enrollAssistantRun(
        { userId: 'user-1' },
        { manager, isPrincipalActive: async () => true },
      );

      expect(getAssistantRun({ assistantRun: run })).toBe(run);
      expect(getAssistantRun({}).stopped).toBe(false);
      await run.settle(closedResponse());
    } finally {
      await manager.destroy();
    }
  });
});

describe('unmanaged Assistants run', () => {
  it('has nothing to stop or drain', async () => {
    const run = unmanagedAssistantRun();
    const handler = jest.fn().mockResolvedValue(undefined);
    const work = Promise.resolve('done');

    expect(run.stopped).toBe(false);
    expect(run.signal.aborted).toBe(false);
    expect(run.track(work)).toBe(work);
    expect(run.guard(handler)).toBe(handler);
    expect(run.guardErrors(new FakeResponse(), handler)).toBe(handler);
    expect(() => run.throwIfStopped()).not.toThrow();
    expect(() =>
      run.cancelOnStop(
        { beta: { threads: { runs: { cancel: jest.fn() } } } },
        { thread_id: 't', run_id: 'r' },
      ),
    ).not.toThrow();
  });
});

describe('Assistants run admission against the deletion marker', () => {
  let mongo: MongoMemoryServer;
  let methods: ReturnType<typeof createMethods>;
  let manager: GenerationJobManagerClass;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    createModels(mongoose);
    await mongoose.connect(mongo.getUri());
    methods = createMethods(mongoose);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongo?.stop();
  });

  beforeEach(() => {
    manager = createManager();
  });

  afterEach(async () => {
    await manager.destroy();
    await mongoose.connection.db?.dropDatabase();
  });

  const enrollFor = (userId: string) =>
    enrollAssistantRun(
      { userId },
      { manager, isPrincipalActive: methods.isAgentTriggerPrincipalActive },
    );

  it('admits a live account, then refuses it once deletion began or the user is gone', async () => {
    const userId = new mongoose.Types.ObjectId();
    await mongoose.models.User.collection.insertOne({ _id: userId, email: 'run@example.com' });
    const id = userId.toString();

    const run = await enrollFor(id);
    await expect(manager.getCleanupBlockingJobIdsForUser(id)).resolves.toHaveLength(1);

    const stopping = stopUserGenerations(id, undefined, manager);
    await flush();
    expect(run.stopped).toBe(true);
    await run.settle(closedResponse());
    await stopping;

    await expect(methods.beginAgentTriggerUserDeletion(id, new Date())).resolves.toBe('acquired');
    await expect(enrollFor(id)).rejects.toMatchObject({ code: 'ACCOUNT_DELETION_IN_PROGRESS' });

    await mongoose.models.User.deleteOne({ _id: userId });
    await expect(enrollFor(id)).rejects.toMatchObject({ code: 'ACCOUNT_DELETION_IN_PROGRESS' });
    await expect(manager.getCleanupBlockingJobIdsForUser(id)).resolves.toEqual([]);
  });
});
