import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createModels, logger, runAfterTransaction, tenantStorage } from '..';
import {
  PermissionBits,
  PrincipalModel,
  PrincipalType,
  ResourceType,
  Time,
} from 'librechat-data-provider';
import type { CacheStore } from '~/types';
import { createMethods } from './index';

logger.silent = true;

type Methods = ReturnType<typeof createMethods>;
type AclEntryDoc = { principalType: string; resourceId: unknown; permBits: number };

let mongoServer: MongoMemoryServer;
let methods: Methods;
let AclEntry: mongoose.Model<unknown>;
let Prompt: mongoose.Model<unknown>;
let PromptGroup: mongoose.Model<unknown>;
let cacheMap: Map<string, unknown>;
let delaySets = false;
let resolvePendingSets: Array<() => void> = [];
let delayDeletes = false;
let resolvePendingDeletes: Array<() => void> = [];
let generationTtls: Array<number | undefined> = [];
let failGenerationReads = false;
let failGenerationWrites = false;
let failGenerationDeletes = false;
let notifyPendingSet: (() => void) | undefined;

const cacheStore: CacheStore = {
  get: async (key) => {
    if (failGenerationReads && key.includes(':generation')) {
      throw new Error('marker read failed');
    }
    return cacheMap.get(key);
  },
  set: async (key, value, ttl) => {
    if (failGenerationWrites && key.includes(':generation')) {
      return false;
    }
    /** The generation entry itself must never be held back by the test gate */
    if (delaySets && !key.includes(':generation')) {
      notifyPendingSet?.();
      await new Promise<void>((resolve) => resolvePendingSets.push(resolve));
    }
    if (key.includes(':generation')) {
      generationTtls.push(ttl);
    }
    cacheMap.set(key, value);
  },
  delete: async (key) => {
    if (failGenerationDeletes && key.includes(':generation')) {
      return false;
    }
    if (delayDeletes) {
      await new Promise<void>((resolve) => resolvePendingDeletes.push(resolve));
    }
    cacheMap.delete(key);
  },
  clear: async () => {
    cacheMap.clear();
  },
};

const idStrings = (ids: Array<mongoose.Types.ObjectId>): string[] => ids.map((id) => id.toString());

async function seedGroupAndPrompt(author: mongoose.Types.ObjectId) {
  const prompt = await Prompt.create({
    groupId: new mongoose.Types.ObjectId(),
    author,
    prompt: 'Hello {{name}}',
    type: 'text',
  });
  const group = await PromptGroup.create({
    name: `Group ${new mongoose.Types.ObjectId().toString().slice(-6)}`,
    author,
    authorName: 'Test Author',
    productionId: prompt._id,
  });
  return group;
}

async function grantView(
  principalType: string,
  principalId: mongoose.Types.ObjectId | null,
  resourceId: unknown,
) {
  const principalModels: Record<string, string> = {
    [PrincipalType.USER]: PrincipalModel.USER,
    [PrincipalType.GROUP]: PrincipalModel.GROUP,
    [PrincipalType.ROLE]: PrincipalModel.ROLE,
  };
  await AclEntry.create({
    principalType,
    ...(principalId ? { principalId } : {}),
    ...(principalModels[principalType] ? { principalModel: principalModels[principalType] } : {}),
    resourceType: ResourceType.PROMPTGROUP,
    resourceId,
    permBits: PermissionBits.VIEW,
  } as AclEntryDoc);
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  AclEntry = mongoose.models.AclEntry;
  Prompt = mongoose.models.Prompt;
  PromptGroup = mongoose.models.PromptGroup;
  cacheMap = new Map();
  methods = createMethods(mongoose, { getCache: () => cacheStore });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  failGenerationWrites = false;
  failGenerationDeletes = false;
  await Promise.all([AclEntry.deleteMany({}), Prompt.deleteMany({}), PromptGroup.deleteMany({})]);
  await methods.invalidatePromptGroupAccessContext();
  delaySets = false;
  resolvePendingSets.forEach((resolve) => resolve());
  resolvePendingSets = [];
  delayDeletes = false;
  resolvePendingDeletes.forEach((resolve) => resolve());
  resolvePendingDeletes = [];
  failGenerationReads = false;
  notifyPendingSet = undefined;
});

describe('getPromptGroupAccessContext', () => {
  it('resolves user-accessible, public, and owned prompt group ID sets', async () => {
    const userId = new mongoose.Types.ObjectId();
    const otherId = new mongoose.Types.ObjectId();
    const ownGroup = await seedGroupAndPrompt(userId);
    const publicGroup = await seedGroupAndPrompt(otherId);
    const hiddenGroup = await seedGroupAndPrompt(otherId);

    await grantView(PrincipalType.USER, userId, ownGroup._id);
    await grantView(PrincipalType.PUBLIC, null, publicGroup._id);

    const { accessibleIds, publiclyAccessibleIds, ownedPromptGroupIds } =
      await methods.getPromptGroupAccessContext({ userId: userId.toString(), role: 'USER' });

    expect(idStrings(publiclyAccessibleIds)).toEqual([publicGroup._id.toString()]);
    expect(idStrings(ownedPromptGroupIds)).toEqual([ownGroup._id.toString()]);

    const accessible = idStrings(accessibleIds);
    expect(accessible).toContain(ownGroup._id.toString());
    expect(accessible).toContain(publicGroup._id.toString());
    expect(accessible).not.toContain(hiddenGroup._id.toString());
  });

  it('serves repeat reads from the cache and refreshes after invalidation', async () => {
    const userId = new mongoose.Types.ObjectId();
    const ownGroup = await seedGroupAndPrompt(userId);
    const sharedGroup = await seedGroupAndPrompt(new mongoose.Types.ObjectId());
    await grantView(PrincipalType.USER, userId, ownGroup._id);

    await methods.getPromptGroupAccessContext({ userId: userId.toString(), role: 'USER' });

    await grantView(PrincipalType.USER, userId, sharedGroup._id);

    const stale = await methods.getPromptGroupAccessContext({
      userId: userId.toString(),
      role: 'USER',
    });
    expect(idStrings(stale.accessibleIds)).not.toContain(sharedGroup._id.toString());

    await methods.invalidatePromptGroupAccessContext();

    const fresh = await methods.getPromptGroupAccessContext({
      userId: userId.toString(),
      role: 'USER',
    });
    expect(idStrings(fresh.accessibleIds)).toContain(sharedGroup._id.toString());
  });

  it('shares the public set across users and invalidates it on group deletion', async () => {
    const authorId = new mongoose.Types.ObjectId();
    const publicGroup = await seedGroupAndPrompt(authorId);
    await grantView(PrincipalType.PUBLIC, null, publicGroup._id);

    const authorCtx = await methods.getPromptGroupAccessContext({
      userId: authorId.toString(),
      role: 'USER',
    });
    const otherCtx = await methods.getPromptGroupAccessContext({
      userId: new mongoose.Types.ObjectId().toString(),
      role: 'USER',
    });

    expect(idStrings(authorCtx.publiclyAccessibleIds)).toEqual([publicGroup._id.toString()]);
    expect(idStrings(otherCtx.publiclyAccessibleIds)).toEqual([publicGroup._id.toString()]);

    await methods.deletePromptGroup({ _id: publicGroup._id.toString() });

    const afterDelete = await methods.getPromptGroupAccessContext({
      userId: authorId.toString(),
      role: 'USER',
    });
    expect(idStrings(afterDelete.publiclyAccessibleIds)).toEqual([]);
  });

  it('invalidates cached owned IDs when a prompt group is created', async () => {
    const userId = new mongoose.Types.ObjectId();
    const before = await methods.getPromptGroupAccessContext({
      userId: userId.toString(),
      role: 'USER',
    });
    expect(before.ownedPromptGroupIds).toHaveLength(0);

    await methods.createPromptGroup({
      prompt: { prompt: 'Created', type: 'text' },
      group: { name: 'Created Group' },
      author: userId.toString(),
      authorName: 'Test Author',
    });

    const after = await methods.getPromptGroupAccessContext({
      userId: userId.toString(),
      role: 'USER',
    });
    expect(after.ownedPromptGroupIds).toHaveLength(1);
  });

  it('drops access granted through a user group when the member is removed', async () => {
    const userId = new mongoose.Types.ObjectId();
    const userGroup = await methods.createGroup({
      name: 'Editors',
      memberIds: [userId.toString()],
    });
    const groupPrompt = await seedGroupAndPrompt(new mongoose.Types.ObjectId());
    await grantView(PrincipalType.GROUP, userGroup._id, groupPrompt._id);

    const before = await methods.getPromptGroupAccessContext({
      userId: userId.toString(),
      role: 'USER',
    });
    expect(idStrings(before.accessibleIds)).toContain(groupPrompt._id.toString());

    await methods.removeMemberById(userGroup._id, userId.toString());

    const after = await methods.getPromptGroupAccessContext({
      userId: userId.toString(),
      role: 'USER',
    });
    expect(idStrings(after.accessibleIds)).not.toContain(groupPrompt._id.toString());
  });

  it('cannot read IDs written back by a build that was in flight across an invalidation', async () => {
    const userId = new mongoose.Types.ObjectId();
    const ownGroup = await seedGroupAndPrompt(userId);
    await grantView(PrincipalType.USER, userId, ownGroup._id);

    const pendingSet = new Promise<void>((resolve) => {
      notifyPendingSet = resolve;
    });
    delaySets = true;
    const firstResolve = methods.getPromptGroupAccessContext({
      userId: userId.toString(),
      role: 'USER',
    });
    await pendingSet;

    await AclEntry.deleteMany({ resourceId: ownGroup._id });
    await methods.invalidatePromptGroupAccessContext();

    delaySets = false;
    resolvePendingSets.forEach((resolve) => resolve());
    resolvePendingSets = [];
    await firstResolve;

    const fresh = await methods.getPromptGroupAccessContext({
      userId: userId.toString(),
      role: 'USER',
    });
    expect(idStrings(fresh.accessibleIds)).not.toContain(ownGroup._id.toString());
  });

  it('does not resurrect an old cache era when generation initializers overlap', async () => {
    const userId = new mongoose.Types.ObjectId();
    const ownGroup = await seedGroupAndPrompt(userId);
    await grantView(PrincipalType.USER, userId, ownGroup._id);

    const raceMap = new Map<string, unknown>();
    let generationReadCount = 0;
    let generationSetCount = 0;
    let releaseFirstGenerationRead!: () => void;
    let releaseSecondInitialization!: () => void;
    let signalSecondInitialization!: () => void;
    const firstGenerationRead = new Promise<void>((resolve) => {
      releaseFirstGenerationRead = resolve;
    });
    const secondInitialization = new Promise<void>((resolve) => {
      signalSecondInitialization = resolve;
    });
    const secondInitializationGate = new Promise<void>((resolve) => {
      releaseSecondInitialization = resolve;
    });
    const raceStore: CacheStore = {
      get: async (key) => {
        if (key === 'access:generation' && generationReadCount < 2) {
          generationReadCount += 1;
          if (generationReadCount === 1) {
            await firstGenerationRead;
          } else {
            releaseFirstGenerationRead();
          }
          return undefined;
        }
        return raceMap.get(key);
      },
      set: async (key, value) => {
        if (key === 'access:generation') {
          generationSetCount += 1;
          if (generationSetCount === 2) {
            signalSecondInitialization();
            await secondInitializationGate;
          }
        }
        raceMap.set(key, value);
      },
    };
    const raceMethods = createMethods(mongoose, { getCache: () => raceStore });
    const dateNow = jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);

    try {
      const requestA = raceMethods.getPromptGroupAccessContext({
        userId: userId.toString(),
        role: 'USER',
      });
      const requestB = raceMethods.getPromptGroupAccessContext({
        userId: userId.toString(),
        role: 'USER',
      });

      await secondInitialization;
      const beforeMutation = await Promise.race([requestA, requestB]);
      expect(idStrings(beforeMutation.accessibleIds)).toContain(ownGroup._id.toString());

      await AclEntry.deleteMany({ resourceId: ownGroup._id });
      await raceMethods.invalidatePromptGroupAccessContext();
      releaseSecondInitialization();
      await Promise.all([requestA, requestB]);

      const afterMutation = await raceMethods.getPromptGroupAccessContext({
        userId: userId.toString(),
        role: 'USER',
      });
      expect(idStrings(afterMutation.accessibleIds)).not.toContain(ownGroup._id.toString());
    } finally {
      dateNow.mockRestore();
      releaseSecondInitialization();
    }
  });

  it('only marks in-flight lookups stale for the active tenant', async () => {
    const userId = new mongoose.Types.ObjectId();
    const ownGroup = await seedGroupAndPrompt(userId);
    await grantView(PrincipalType.USER, userId, ownGroup._id);

    const pendingSet = new Promise<void>((resolve) => {
      notifyPendingSet = resolve;
    });
    delaySets = true;
    const tenantBResolve = tenantStorage.run({ tenantId: 'tenant-b' }, () =>
      methods.getPromptGroupAccessContext({ userId: userId.toString(), role: 'USER' }),
    );
    await pendingSet;

    await tenantStorage.run({ tenantId: 'tenant-a' }, () =>
      methods.invalidatePromptGroupAccessContext(),
    );

    delaySets = false;
    resolvePendingSets.forEach((resolve) => resolve());
    resolvePendingSets = [];
    await tenantBResolve;

    const userKey = `:user:${userId.toString()}:USER:tenant-b`;
    expect([...cacheMap.keys()].some((key) => key.includes(userKey))).toBe(true);
  });

  it('does not reuse an expired generation value after the marker itself expires', async () => {
    const userId = new mongoose.Types.ObjectId();
    const ownGroup = await seedGroupAndPrompt(userId);
    await grantView(PrincipalType.USER, userId, ownGroup._id);

    await methods.getPromptGroupAccessContext({ userId: userId.toString(), role: 'USER' });
    await methods.invalidatePromptGroupAccessContext();
    const primed = await methods.getPromptGroupAccessContext({
      userId: userId.toString(),
      role: 'USER',
    });
    expect(idStrings(primed.accessibleIds)).toContain(ownGroup._id.toString());

    await AclEntry.deleteMany({ resourceId: ownGroup._id });
    cacheMap.delete('access:generation');
    await methods.invalidatePromptGroupAccessContext();

    const fresh = await methods.getPromptGroupAccessContext({
      userId: userId.toString(),
      role: 'USER',
    });
    expect(idStrings(fresh.accessibleIds)).not.toContain(ownGroup._id.toString());
  });

  it('does not cache a failed ownership lookup as empty', async () => {
    const userId = new mongoose.Types.ObjectId();
    const ownGroup = await seedGroupAndPrompt(userId);
    await grantView(PrincipalType.USER, userId, ownGroup._id);

    const findSpy = jest.spyOn(PromptGroup, 'find');
    findSpy.mockImplementationOnce(() => {
      throw new Error('transient failure');
    });

    await expect(
      methods.getPromptGroupAccessContext({ userId: userId.toString(), role: 'USER' }),
    ).rejects.toThrow('transient failure');
    findSpy.mockRestore();

    const recovered = await methods.getPromptGroupAccessContext({
      userId: userId.toString(),
      role: 'USER',
    });
    expect(idStrings(recovered.ownedPromptGroupIds)).toEqual([ownGroup._id.toString()]);
  });

  it('reinitializes an evicted marker instead of reusing generation zero', async () => {
    const userId = new mongoose.Types.ObjectId();
    const ownGroup = await seedGroupAndPrompt(userId);
    await grantView(PrincipalType.USER, userId, ownGroup._id);

    await methods.getPromptGroupAccessContext({ userId: userId.toString(), role: 'USER' });
    await AclEntry.deleteMany({ resourceId: ownGroup._id });
    await methods.invalidatePromptGroupAccessContext();
    /** Simulate the marker being evicted while the pre-revocation entry is still alive */
    cacheMap.delete('access:generation');

    const after = await methods.getPromptGroupAccessContext({
      userId: userId.toString(),
      role: 'USER',
    });
    expect(idStrings(after.accessibleIds)).not.toContain(ownGroup._id.toString());
  });

  it('bypasses the cache instead of guessing a generation when the marker read fails', async () => {
    const userId = new mongoose.Types.ObjectId();
    const ownGroup = await seedGroupAndPrompt(userId);
    await grantView(PrincipalType.USER, userId, ownGroup._id);

    await methods.getPromptGroupAccessContext({ userId: userId.toString(), role: 'USER' });
    await AclEntry.deleteMany({ resourceId: ownGroup._id });
    await methods.invalidatePromptGroupAccessContext();

    failGenerationReads = true;
    const bypassed = await methods.getPromptGroupAccessContext({
      userId: userId.toString(),
      role: 'USER',
    });
    expect(idStrings(bypassed.accessibleIds)).not.toContain(ownGroup._id.toString());
    failGenerationReads = false;
  });

  it('removes the old generation before a replacement write can fail', async () => {
    const userId = new mongoose.Types.ObjectId();
    const ownGroup = await seedGroupAndPrompt(userId);
    await grantView(PrincipalType.USER, userId, ownGroup._id);

    await methods.getPromptGroupAccessContext({ userId: userId.toString(), role: 'USER' });
    await AclEntry.deleteMany({ resourceId: ownGroup._id });

    failGenerationWrites = true;
    await methods.invalidatePromptGroupAccessContext();
    failGenerationWrites = false;

    const fresh = await methods.getPromptGroupAccessContext({
      userId: userId.toString(),
      role: 'USER',
    });
    expect(idStrings(fresh.accessibleIds)).not.toContain(ownGroup._id.toString());
  });

  it('bypasses access caching when the old generation cannot be replaced or removed', async () => {
    const userId = new mongoose.Types.ObjectId();
    const ownGroup = await seedGroupAndPrompt(userId);
    await grantView(PrincipalType.USER, userId, ownGroup._id);

    await methods.getPromptGroupAccessContext({ userId: userId.toString(), role: 'USER' });
    const previousGeneration = cacheMap.get('access:generation');
    await AclEntry.deleteMany({ resourceId: ownGroup._id });

    failGenerationDeletes = true;
    failGenerationWrites = true;
    await expect(methods.invalidatePromptGroupAccessContext()).rejects.toThrow(
      'Prompt group access generation write failed',
    );
    failGenerationDeletes = false;
    failGenerationWrites = false;
    expect(cacheMap.get('access:generation')).toBe(previousGeneration);

    const bypassed = await methods.getPromptGroupAccessContext({
      userId: userId.toString(),
      role: 'USER',
    });
    expect(idStrings(bypassed.accessibleIds)).not.toContain(ownGroup._id.toString());
  });

  it('writes the generation marker with a ttl that outlives cached entries', async () => {
    generationTtls = [];
    await methods.invalidatePromptGroupAccessContext();
    expect(generationTtls.length).toBeGreaterThan(0);
    for (const ttl of generationTtls) {
      expect(ttl).toBeGreaterThanOrEqual(Time.ONE_DAY);
    }
  });

  it('does not cache access built from a stale membership while its eviction is pending', async () => {
    const userId = new mongoose.Types.ObjectId();
    const userGroup = await methods.createGroup({
      name: 'Editors',
      memberIds: [userId.toString()],
    });
    const groupPrompt = await seedGroupAndPrompt(new mongoose.Types.ObjectId());
    await grantView(PrincipalType.GROUP, userGroup._id, groupPrompt._id);

    const before = await methods.getPromptGroupAccessContext({
      userId: userId.toString(),
      role: 'USER',
    });
    expect(idStrings(before.accessibleIds)).toContain(groupPrompt._id.toString());

    delayDeletes = true;
    const removal = methods.removeMemberById(userGroup._id, userId.toString());
    await new Promise((resolve) => setTimeout(resolve, 25));
    await methods.getPromptGroupAccessContext({ userId: userId.toString(), role: 'USER' });

    delayDeletes = false;
    resolvePendingDeletes.forEach((resolve) => resolve());
    resolvePendingDeletes = [];
    await removal;

    const after = await methods.getPromptGroupAccessContext({
      userId: userId.toString(),
      role: 'USER',
    });
    expect(idStrings(after.accessibleIds)).not.toContain(groupPrompt._id.toString());
  });
});

describe('runAfterTransaction', () => {
  function createSession(abortError?: Error) {
    let active = true;
    const endedHandlers: Array<() => void> = [];
    const abortTransaction = jest.fn(async (_options?: { timeoutMS?: number }) => {
      active = false;
      if (abortError) {
        throw abortError;
      }
    });
    const rawSession = {
      inTransaction: () => active,
      commitTransaction: jest.fn(async () => {
        active = false;
      }),
      abortTransaction,
      once: (event: string, handler: () => void) => {
        if (event === 'ended') {
          endedHandlers.push(handler);
        }
      },
    };
    return {
      abortTransaction,
      endedHandlers,
      session: rawSession as unknown as NonNullable<Parameters<typeof runAfterTransaction>[0]>,
      startTransaction: () => {
        active = true;
      },
    };
  }

  it('defers invalidation until a caller-owned session commits', async () => {
    const { session } = createSession();
    const invalidate = jest.fn().mockResolvedValue(undefined);

    await runAfterTransaction(session, invalidate);
    expect(invalidate).not.toHaveBeenCalled();

    await session.commitTransaction();
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('discards deferred invalidation when the transaction aborts', async () => {
    const { endedHandlers, session } = createSession();
    const invalidate = jest.fn().mockResolvedValue(undefined);

    await runAfterTransaction(session, invalidate);
    await session.abortTransaction();
    endedHandlers.forEach((fire) => fire());

    expect(invalidate).not.toHaveBeenCalled();
  });

  it('does not carry a failed abort queue into a reused session', async () => {
    const abortError = new Error('abort failed');
    const { abortTransaction, session, startTransaction } = createSession(abortError);
    const abortedInvalidate = jest.fn().mockResolvedValue(undefined);
    const committedInvalidate = jest.fn().mockResolvedValue(undefined);

    await runAfterTransaction(session, abortedInvalidate);
    await expect(session.abortTransaction({ timeoutMS: 25 })).rejects.toThrow(abortError);
    expect(abortTransaction).toHaveBeenCalledWith({ timeoutMS: 25 });

    startTransaction();
    await runAfterTransaction(session, committedInvalidate);
    await session.commitTransaction();

    expect(abortedInvalidate).not.toHaveBeenCalled();
    expect(committedInvalidate).toHaveBeenCalledTimes(1);
  });

  it('drains only the current queue when a session is reused', async () => {
    const { session, startTransaction } = createSession();
    const firstInvalidate = jest.fn().mockResolvedValue(undefined);
    const secondInvalidate = jest.fn().mockResolvedValue(undefined);

    await runAfterTransaction(session, firstInvalidate);
    await session.commitTransaction();
    startTransaction();
    await runAfterTransaction(session, secondInvalidate);
    await session.commitTransaction();

    expect(firstInvalidate).toHaveBeenCalledTimes(1);
    expect(secondInvalidate).toHaveBeenCalledTimes(1);
  });

  it('runs invalidation immediately without an active transaction', async () => {
    const invalidate = jest.fn();
    await runAfterTransaction(undefined, invalidate);
    expect(invalidate).toHaveBeenCalledTimes(1);
  });
});
