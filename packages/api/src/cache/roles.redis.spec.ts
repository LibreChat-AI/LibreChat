import { Keyv } from 'keyv';
import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import KeyvRedis from '@keyv/redis';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { CacheKeys, PermissionTypes, Permissions } from 'librechat-data-provider';
import {
  createModels,
  createMethods,
  tenantStorage,
  createRoleChangeSource,
} from '@librechat/data-schemas';
import type { IRole, RoleChangeSource } from '@librechat/data-schemas';
import { createRegionalRoleCache, startRoleCacheInvalidation } from './roles';
import { generateCheckAccess } from '~/middleware/access';

/**
 * Opt in with three independent disposable Redis endpoints. The DB is a real local Mongo
 * replica set; this verifies adapters and actual change streams, not compatibility with other MongoDB-compatible engines.
 */
const urls = process.env.ROLE_CACHE_REDIS_URLS?.split(',') ?? [];
if (process.env.ROLE_CACHE_REQUIRE_INTEGRATION === '1' && urls.length !== 3) {
  throw new Error('ROLE_CACHE_REDIS_URLS must contain three disposable Redis endpoints');
}
const integration = urls.length === 3 ? describe : describe.skip;
const tenant = 'regional-role-integration-tenant';
const name = 'EDITOR';

function runAs<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return tenantStorage.run({ tenantId }, fn);
}

const config = { enabled: true, ttlMs: 60_000, retryDelayMs: 100, maxAwaitTimeMs: 100 };

async function until(check: () => Promise<boolean>, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Regional permission change did not propagate in time');
}

integration(
  'role invalidation with Mongo change streams and three independent Redis servers',
  () => {
    let mongo: MongoMemoryReplSet;
    let Role: mongoose.Model<IRole>;
    const bases: Keyv[] = [];
    const adapters: KeyvRedis<string>[] = [];
    const caches: ReturnType<typeof createRegionalRoleCache>[] = [];
    const stops: (() => Promise<void>)[] = [];
    const apps: express.Express[] = [];
    const methods: ReturnType<typeof createMethods>[] = [];
    const onError = jest.fn();
    const established = [0, 0, 0];

    beforeAll(async () => {
      mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
      await mongoose.connect(mongo.getUri(), { dbName: 'regional_role_integration' });
      createModels(mongoose);
      Role = mongoose.models.Role as mongoose.Model<IRole>;
      await runAs(tenant, () =>
        new Role({ name, permissions: { MCP_SERVERS: { USE: true, CREATE: false } } }).save(),
      );

      for (let region = 0; region < 3; region++) {
        const adapter = new KeyvRedis(urls[region]);
        adapters.push(adapter);
        const base = new Keyv({ store: adapter, namespace: `role-integration-${region}` });
        bases.push(base);
        const cache = createRegionalRoleCache({ cache: base, onError });
        caches.push(cache);
        const source = createRoleChangeSource(mongoose);
        const open: RoleChangeSource = (options) => {
          const cursor = source(options);
          return {
            tryNext: async () => {
              const event = await cursor.tryNext();
              established[region]++;
              return event;
            },
            close: () => cursor.close(),
          };
        };
        stops.push(await startRoleCacheInvalidation({ config, cache, open, onError }));
        const db = createMethods(mongoose, {
          getCache: (key) => (key === CacheKeys.ROLES ? cache : undefined),
        });
        methods.push(db);
        const guard = generateCheckAccess({
          permissionType: PermissionTypes.MCP_SERVERS,
          permissions: [Permissions.USE, Permissions.CREATE],
          getRoleByName: (role) => runAs(tenant, () => db.getRoleByName(role)),
        });
        const app = express();
        app.post(
          '/servers',
          (req, res, next) => {
            Object.assign(req, { user: { id: 'integration-user', role: name } });
            void guard(req, res, next);
          },
          (_req, res) => {
            res.sendStatus(201);
          },
        );
        apps.push(app);
      }
      await until(async () => established.every((value) => value > 0));
    }, 60_000);

    afterAll(async () => {
      await Promise.all(stops.map((stop) => stop()));
      await Promise.all(adapters.map((adapter) => adapter.disconnect()));
      await mongoose.disconnect();
      await mongo?.stop();
    });

    it('propagates grants and revocations and preserves cache hits between changes', async () => {
      for (const app of apps) {
        expect((await request(app).post('/servers')).status).toBe(403);
      }
      const find = jest.spyOn(Role, 'findOne');
      for (const app of apps) {
        expect((await request(app).post('/servers')).status).toBe(403);
      }
      expect(find).not.toHaveBeenCalled();
      find.mockRestore();

      for (const writer of methods) {
        const started = Date.now();
        await runAs(tenant, async () => {
          const role = await writer.getPartitionRole(name);
          await writer.updateAccessPermissions(name, { MCP_SERVERS: { CREATE: true } }, role!);
        });
        await until(async () =>
          (await Promise.all(apps.map((app) => request(app).post('/servers')))).every(
            (res) => res.status === 201,
          ),
        );
        expect(Date.now() - started).toBeLessThan(5000);

        await runAs(tenant, async () => {
          const role = await writer.getPartitionRole(name);
          await writer.updateAccessPermissions(name, { MCP_SERVERS: { CREATE: false } }, role!);
        });
        await until(async () =>
          (await Promise.all(apps.map((app) => request(app).post('/servers')))).every(
            (res) => res.status === 403,
          ),
        );
      }
      expect(onError).not.toHaveBeenCalled();
    });

    it('a delayed stale fill stays unreachable after an invalidation', async () => {
      const old = await caches[1].snapshot!();
      await caches[1].invalidate();
      const current = await caches[1].snapshot!();
      await current.set('race', { CREATE: false });
      await old.set('race', { CREATE: true });
      expect(await caches[1].get('race')).toEqual({ CREATE: false });
    });

    it('keeps identical role names isolated by tenant and pins cold reads to primary', async () => {
      const otherTenant = 'regional-role-other-tenant';
      await runAs(otherTenant, () =>
        new Role({ name, permissions: { MCP_SERVERS: { USE: true, CREATE: true } } }).save(),
      );
      await caches[0].invalidate();
      const read = jest.spyOn(mongoose.Query.prototype, 'read');
      const other = await runAs(otherTenant, () => methods[0].getRoleByName(name));
      const original = await runAs(tenant, () => methods[0].getRoleByName(name));
      expect(other.tenantId).toBe(otherTenant);
      expect(original.tenantId).toBe(tenant);
      expect(read).toHaveBeenCalledWith('primary');
      expect(other.permissions.MCP_SERVERS?.CREATE).toBe(true);
      expect(original.permissions.MCP_SERVERS?.CREATE).toBe(false);
      read.mockRestore();
    });

    it('recovers through expiry when a region misses an event, without a request-time DB check on hits', async () => {
      await stops[1]();
      caches[1].configure(200);
      await caches[1].invalidate();
      expect((await request(apps[1]).post('/servers')).status).toBe(403);
      await runAs(tenant, () =>
        methods[2].updateRoleByName(name, {
          permissions: { MCP_SERVERS: { USE: true, CREATE: true } },
        }),
      );
      await until(async () => (await request(apps[1]).post('/servers')).status === 201, 2000);
      // Restore the advertised runtime configuration; the short TTL above accelerates this failure test.
      caches[1].configure(config.ttlMs);
      expect(onError).not.toHaveBeenCalled();
    });

    it('propagates a real Redis write rejection only after enabling regional caching', async () => {
      const adapter = new KeyvRedis(urls[0]);
      const base = new Keyv({ store: adapter, namespace: 'role-adapter-errors' });
      // Production attaches an error listener; rejection must not depend on an unhandled event.
      base.on('error', () => undefined);
      const cache = createRegionalRoleCache({ cache: base, onError: jest.fn() });
      await base.get('connect');
      await adapter.client.configSet('maxmemory', '1');
      try {
        expect(await cache.set('legacy', {})).toBe(true);
        expect(await base.get('legacy')).toBeUndefined();
        cache.configure(config.ttlMs);
        await expect(cache.invalidate()).rejects.toThrow();
        await expect(cache.set('USER', {})).rejects.toThrow();
        const read = await cache.snapshot!();
        expect(read.primaryReads).toBe(true);
        expect(await read.get('USER')).toBeUndefined();
      } finally {
        await adapter.client.configSet('maxmemory', '0');
        await adapter.disconnect();
      }
    });

    it('rejects a role update after its DB commit when regional invalidation fails', async () => {
      await stops[0]();
      const publish = jest.spyOn(bases[0], 'set').mockResolvedValueOnce(false);
      try {
        await expect(
          runAs(tenant, () =>
            methods[0].updateRoleByName(name, {
              permissions: { MCP_SERVERS: { USE: true, CREATE: false } },
            }),
          ),
        ).rejects.toThrow('Role cache generation update failed');
        const committed = await runAs(tenant, () =>
          Role.findOne({ name }).read('primary').lean().exec(),
        );
        expect(committed?.permissions.MCP_SERVERS?.CREATE).toBe(false);
      } finally {
        publish.mockRestore();
      }
    });
  },
);
