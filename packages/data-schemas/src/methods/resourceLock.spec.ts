import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type * as t from '~/types';
import { createResourceLockMethods } from './resourceLock';
import resourceLockSchema from '~/schema/resourceLock';

let mongoServer: MongoMemoryServer;
let methods: ReturnType<typeof createResourceLockMethods>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  if (!mongoose.models.ResourceLock) {
    mongoose.model<t.IResourceLock>('ResourceLock', resourceLockSchema);
  }
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
  methods = createResourceLockMethods(mongoose);
});

describe('resource locks', () => {
  it('grants the lease to one owner at a time', async () => {
    const key = 'acl:agent:1';
    expect(await methods.acquireResourceLock({ key, ownerId: 'a', ttlMs: 30_000 })).toBe(true);
    expect(await methods.acquireResourceLock({ key, ownerId: 'b', ttlMs: 30_000 })).toBe(false);
    expect(
      await methods.acquireResourceLock({ key: 'acl:agent:2', ownerId: 'b', ttlMs: 30_000 }),
    ).toBe(true);
  });

  it('lets another owner take over a lease its crashed holder left to expire', async () => {
    const key = 'acl:agent:1';
    await methods.acquireResourceLock({ key, ownerId: 'crashed', ttlMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(await methods.acquireResourceLock({ key, ownerId: 'b', ttlMs: 30_000 })).toBe(true);
    expect(await methods.releaseResourceLock({ key, ownerId: 'crashed' })).toBe(false);
  });

  it('ignores a release from a non-owner and frees the lease for the owner', async () => {
    const key = 'acl:agent:1';
    await methods.acquireResourceLock({ key, ownerId: 'a', ttlMs: 30_000 });

    expect(await methods.releaseResourceLock({ key, ownerId: 'b' })).toBe(false);
    expect(await methods.acquireResourceLock({ key, ownerId: 'b', ttlMs: 30_000 })).toBe(false);
    expect(await methods.releaseResourceLock({ key, ownerId: 'a' })).toBe(true);
    expect(await methods.acquireResourceLock({ key, ownerId: 'b', ttlMs: 30_000 })).toBe(true);
  });

  it('renews only for the live holder', async () => {
    const key = 'acl:agent:1';
    await methods.acquireResourceLock({ key, ownerId: 'a', ttlMs: 30_000 });
    expect(await methods.renewResourceLock({ key, ownerId: 'a', ttlMs: 30_000 })).toBe(true);
    expect(await methods.renewResourceLock({ key, ownerId: 'b', ttlMs: 30_000 })).toBe(false);
    await methods.acquireResourceLock({ key: 'acl:agent:2', ownerId: 'c', ttlMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(
      await methods.renewResourceLock({ key: 'acl:agent:2', ownerId: 'c', ttlMs: 30_000 }),
    ).toBe(false);
  });

  it('never moves the expiry backwards on an overlapping renewal', async () => {
    const key = 'acl:agent:3';
    await methods.acquireResourceLock({ key, ownerId: 'a', ttlMs: 60_000 });
    const before = (await mongoose.models.ResourceLock.findOne({ key }).lean<{
      expiresAt: Date;
    }>())!.expiresAt;
    await methods.renewResourceLock({ key, ownerId: 'a', ttlMs: 1_000 });
    const after = (await mongoose.models.ResourceLock.findOne({ key }).lean<{ expiresAt: Date }>())!
      .expiresAt;
    expect(after.getTime()).toBeGreaterThanOrEqual(before.getTime());
  });
});
