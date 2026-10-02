import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { Collection, Document, WithId } from 'mongodb';
import { runDistributedJob } from './job';

interface JobState extends Document {
  _id: string;
  status: 'running' | 'completed' | 'failed';
  owner?: string;
  expiresAt: Date;
  updatedAt: Date;
}

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    error: jest.fn(),
  },
}));

const createDeferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

describe('runDistributedJob', () => {
  let mongoServer: MongoMemoryServer;
  let mongoClient: MongoClient;
  let collection: Collection<JobState>;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    mongoClient = await MongoClient.connect(mongoServer.getUri());
    collection = mongoClient.db('distributed-job-tests').collection<JobState>('jobs');
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    await collection.deleteMany({});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await mongoClient.close();
    await mongoServer.stop();
  });

  test('allows only one handler to run under concurrent claims', async () => {
    const ownerStarted = createDeferred<void>();
    const releaseOwner = createDeferred<void>();
    const ownerHandler = jest.fn(async () => {
      ownerStarted.resolve();
      await releaseOwner.promise;
      return 'owner';
    });
    const followerHandler = jest.fn(async () => 'follower');
    const options = { pollMs: 5, onLeaseLost: jest.fn() };

    const ownerRun = runDistributedJob(collection, 'contended-job', ownerHandler, options);
    await ownerStarted.promise;
    const followerRun = runDistributedJob(collection, 'contended-job', followerHandler, options);
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseOwner.resolve();

    await expect(Promise.all([ownerRun, followerRun])).resolves.toEqual(['owner', undefined]);
    expect(ownerHandler).toHaveBeenCalledTimes(1);
    expect(followerHandler).not.toHaveBeenCalled();
  });

  test('renews the heartbeat deadline while the owner remains healthy', async () => {
    const ownerStarted = createDeferred<void>();
    const releaseOwner = createDeferred<void>();
    const ownerHandler = jest.fn(async () => {
      ownerStarted.resolve();
      await releaseOwner.promise;
      return 'owner';
    });
    const options = {
      leaseMs: 6000,
      refreshMs: 50,
      pollMs: 5,
      onLeaseLost: jest.fn(),
    };
    const ownerRun = runDistributedJob(collection, 'renewed-job', ownerHandler, options);
    await ownerStarted.promise;
    const initialState = await collection.findOne({ _id: 'renewed-job' });
    if (initialState == null) {
      throw new Error('Expected the owner to create a distributed job state');
    }
    let renewedState: WithId<JobState> | null = initialState;
    for (let attempt = 0; attempt < 50; attempt++) {
      renewedState = await collection.findOne({ _id: 'renewed-job' });
      if (
        renewedState != null &&
        renewedState.expiresAt.getTime() > initialState.expiresAt.getTime()
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(renewedState).toMatchObject({
      owner: initialState.owner,
      status: 'running',
    });
    expect(renewedState?.expiresAt.getTime()).toBeGreaterThan(initialState.expiresAt.getTime());

    const followerController = new AbortController();
    const followerHandler = jest.fn(async () => 'follower');
    const followerRun = runDistributedJob(collection, 'renewed-job', followerHandler, {
      ...options,
      signal: followerController.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    followerController.abort(new Error('stop follower'));

    await expect(followerRun).rejects.toThrow('stop follower');
    expect(followerHandler).not.toHaveBeenCalled();
    expect(options.onLeaseLost).not.toHaveBeenCalled();
    releaseOwner.resolve();
    await expect(ownerRun).resolves.toBe('owner');
  });

  test('takes over after a missed heartbeat reaches its stale deadline', async () => {
    const expiresAt = new Date(Date.now() + 50);
    await collection.insertOne({
      _id: 'missed-heartbeat',
      status: 'running',
      owner: 'stopped-owner',
      expiresAt,
      updatedAt: new Date(),
    });
    const handler = jest.fn(async () => 'recovered');

    await expect(
      runDistributedJob(collection, 'missed-heartbeat', handler, {
        leaseMs: 6000,
        refreshMs: 50,
        pollMs: 5,
        onLeaseLost: jest.fn(),
      }),
    ).resolves.toBe('recovered');

    expect(Date.now()).toBeGreaterThanOrEqual(expiresAt.getTime());
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test('takes over an expired lease', async () => {
    await collection.insertOne({
      _id: 'expired-job',
      status: 'running',
      owner: 'stale-owner',
      expiresAt: new Date(Date.now() - 1000),
      updatedAt: new Date(Date.now() - 1000),
    });
    const handler = jest.fn(async () => 'recovered');

    await expect(
      runDistributedJob(collection, 'expired-job', handler, {
        pollMs: 5,
        onLeaseLost: jest.fn(),
      }),
    ).resolves.toBe('recovered');

    expect(handler).toHaveBeenCalledTimes(1);
    await expect(collection.findOne({ _id: 'expired-job' })).resolves.toMatchObject({
      status: 'completed',
    });
  });

  test('skips a job with a valid completion marker', async () => {
    await collection.insertOne({
      _id: 'completed-job',
      status: 'completed',
      expiresAt: new Date(Date.now() + 60_000),
      updatedAt: new Date(),
    });
    const handler = jest.fn(async () => 'unexpected');

    await expect(
      runDistributedJob(collection, 'completed-job', handler, {
        pollMs: 5,
        onLeaseLost: jest.fn(),
      }),
    ).resolves.toBeUndefined();

    expect(handler).not.toHaveBeenCalled();
  });

  test('does not complete after the owner lease expires', async () => {
    const handlerStarted = createDeferred<void>();
    const releaseHandler = createDeferred<void>();
    const onLeaseLost = jest.fn();
    const running = runDistributedJob(
      collection,
      'stale-completion',
      async () => {
        handlerStarted.resolve();
        await releaseHandler.promise;
        return 'stale result';
      },
      { onLeaseLost },
    );
    await handlerStarted.promise;
    await collection.updateOne(
      { _id: 'stale-completion', status: 'running' },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    releaseHandler.resolve();

    await expect(running).rejects.toThrow('Lost distributed job lease for stale-completion');
    expect(onLeaseLost).toHaveBeenCalledTimes(1);
    await expect(collection.findOne({ _id: 'stale-completion' })).resolves.toMatchObject({
      status: 'running',
    });
  });

  test('does not record failure after the owner lease expires', async () => {
    const handlerStarted = createDeferred<void>();
    const releaseHandler = createDeferred<void>();
    const onLeaseLost = jest.fn();
    const running = runDistributedJob(
      collection,
      'stale-failure',
      async () => {
        handlerStarted.resolve();
        await releaseHandler.promise;
        throw new Error('handler failed');
      },
      { onLeaseLost },
    );
    await handlerStarted.promise;
    await collection.updateOne(
      { _id: 'stale-failure', status: 'running' },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    releaseHandler.resolve();

    await expect(running).rejects.toThrow('Lost distributed job lease for stale-failure');
    expect(onLeaseLost).toHaveBeenCalledTimes(1);
    await expect(collection.findOne({ _id: 'stale-failure' })).resolves.toMatchObject({
      status: 'running',
    });
  });

  test('detects ownership loss during lease renewal', async () => {
    const handlerStarted = createDeferred<void>();
    const releaseHandler = createDeferred<void>();
    const leaseLost = createDeferred<void>();
    const onLeaseLost = jest.fn(() => leaseLost.resolve());
    const running = runDistributedJob(
      collection,
      'renewal-loss',
      async () => {
        handlerStarted.resolve();
        await releaseHandler.promise;
        return 'stale result';
      },
      { leaseMs: 6000, refreshMs: 50, onLeaseLost },
    );
    await handlerStarted.promise;
    await collection.updateOne(
      { _id: 'renewal-loss', status: 'running' },
      { $set: { owner: 'replacement-owner' } },
    );
    await leaseLost.promise;
    releaseHandler.resolve();

    await expect(running).rejects.toThrow('Lost distributed job lease for renewal-loss');
    expect(onLeaseLost).toHaveBeenCalledTimes(1);
  });

  test('retains ownership and fail-stops when a deadline cannot settle the handler', async () => {
    const handlerStarted = createDeferred<void>();
    const neverSettles = createDeferred<void>();
    const onLeaseLost = jest.fn();
    const running = runDistributedJob(
      collection,
      'deadline-job',
      async (signal) => {
        handlerStarted.resolve();
        expect(signal.aborted).toBe(false);
        await neverSettles.promise;
      },
      {
        leaseMs: 6000,
        refreshMs: 50,
        timeoutMs: 100,
        cancellationGraceMs: 25,
        operationTimeoutMs: 100,
        onLeaseLost,
      },
    );
    await handlerStarted.promise;

    await expect(running).rejects.toThrow('Lost distributed job lease for deadline-job');

    const fencedState = await collection.findOne({ _id: 'deadline-job' });
    expect(fencedState).toMatchObject({ status: 'running' });
    expect(fencedState?.owner).toEqual(expect.any(String));
    expect(fencedState?.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(onLeaseLost).toHaveBeenCalledTimes(1);

    const follower = jest.fn(async () => 'unsafe');
    await expect(
      runDistributedJob(collection, 'deadline-job', follower, {
        pollMs: 5,
        timeoutMs: 30,
        cancellationGraceMs: 0,
        operationTimeoutMs: 100,
        onLeaseLost: jest.fn(),
      }),
    ).rejects.toThrow();
    expect(follower).not.toHaveBeenCalled();
    expect((await collection.findOne({ _id: 'deadline-job' }))?.owner).toBe(fencedState?.owner);
  });

  test('releases ownership after a cooperative handler settles on cancellation', async () => {
    const handlerStarted = createDeferred<void>();
    const controller = new AbortController();
    const running = runDistributedJob(
      collection,
      'cancelled-job',
      async (signal) => {
        handlerStarted.resolve();
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
      },
      {
        signal: controller.signal,
        cancellationGraceMs: 100,
        operationTimeoutMs: 100,
        onLeaseLost: jest.fn(),
      },
    );
    await handlerStarted.promise;

    controller.abort(new Error('shutdown'));

    await expect(running).rejects.toThrow('shutdown');
    const cancelledState = await collection.findOne({ _id: 'cancelled-job' });
    expect(cancelledState).toMatchObject({ status: 'failed' });
    expect(cancelledState).not.toHaveProperty('owner');
  });

  test('bounds a never-settling ownership acquisition', async () => {
    const onLeaseLost = jest.fn();
    const handler = jest.fn(async () => undefined);
    const neverSettlingCollection = {
      findOneAndUpdate: jest.fn(() => new Promise(() => undefined)),
    } as unknown as Collection<JobState>;

    await expect(
      runDistributedJob(neverSettlingCollection, 'stuck-acquire', handler, {
        operationTimeoutMs: 50,
        onLeaseLost,
      }),
    ).rejects.toThrow('ownership operation "acquire" exceeded 50ms');

    expect(handler).not.toHaveBeenCalled();
    expect(onLeaseLost).not.toHaveBeenCalled();
  });

  test('bounds a stuck renewal without releasing the lease', async () => {
    const handlerStarted = createDeferred<void>();
    const neverSettles = createDeferred<void>();
    const leaseLost = createDeferred<void>();
    const onLeaseLost = jest.fn(() => leaseLost.resolve());
    const running = runDistributedJob(
      collection,
      'stuck-renewal',
      async () => {
        handlerStarted.resolve();
        await neverSettles.promise;
      },
      {
        leaseMs: 6000,
        refreshMs: 50,
        operationTimeoutMs: 50,
        onLeaseLost,
      },
    );
    await handlerStarted.promise;
    jest
      .spyOn(collection, 'updateOne')
      .mockImplementationOnce(
        () => new Promise(() => undefined) as ReturnType<Collection<JobState>['updateOne']>,
      );

    await leaseLost.promise;
    await expect(running).rejects.toThrow('Lost distributed job lease for stuck-renewal');

    const fencedState = await collection.findOne({ _id: 'stuck-renewal' });
    expect(fencedState).toMatchObject({ status: 'running' });
    expect(fencedState?.owner).toEqual(expect.any(String));
  });

  test('bounds a stuck completion without claiming the job settled', async () => {
    const handlerStarted = createDeferred<void>();
    const releaseHandler = createDeferred<void>();
    const onLeaseLost = jest.fn();
    const running = runDistributedJob(
      collection,
      'stuck-completion',
      async () => {
        handlerStarted.resolve();
        await releaseHandler.promise;
        return 'done';
      },
      { operationTimeoutMs: 50, onLeaseLost },
    );
    await handlerStarted.promise;
    jest
      .spyOn(collection, 'updateOne')
      .mockImplementationOnce(
        () => new Promise(() => undefined) as ReturnType<Collection<JobState>['updateOne']>,
      );
    releaseHandler.resolve();

    await expect(running).rejects.toThrow('Lost distributed job lease for stuck-completion');
    expect(onLeaseLost).toHaveBeenCalledTimes(1);
    const fencedState = await collection.findOne({ _id: 'stuck-completion' });
    expect(fencedState).toMatchObject({ status: 'running' });
    expect(fencedState?.owner).toEqual(expect.any(String));
  });

  test('rejects timing options without a lease safety window', async () => {
    await expect(
      runDistributedJob(collection, 'invalid-timing', async () => undefined, {
        leaseMs: 10_000,
        refreshMs: 5000,
        onLeaseLost: jest.fn(),
      }),
    ).rejects.toThrow('Invalid distributed job timing');

    await expect(collection.countDocuments({})).resolves.toBe(0);
  });
});
