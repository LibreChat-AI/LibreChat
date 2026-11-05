import mongoose from 'mongoose';
import { createModels, createMethods } from '..';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { ResourceLockMethods, ResourceLockAcquireData, ResourceLockReleaseData } from '..';

it('retains resource-lease methods and parameter types through the public factory', async () => {
  const server = await MongoMemoryServer.create();
  const instance = new mongoose.Mongoose();
  instance.set('autoIndex', false);
  instance.set('autoCreate', false);
  try {
    await instance.connect(server.getUri());
    createModels(instance);
    const methods: ResourceLockMethods = createMethods(instance);
    const lock: ResourceLockAcquireData = { key: 'compatibility', ownerId: 'a', ttlMs: 30_000 };
    const release: ResourceLockReleaseData = { key: lock.key, ownerId: lock.ownerId };
    expect(await methods.acquireResourceLock(lock)).toBe(true);
    expect(await methods.renewResourceLock(lock)).toBe(true);
    expect(await methods.releaseResourceLock(release)).toBe(true);
  } finally {
    await instance.disconnect();
    await server.stop();
  }
});
