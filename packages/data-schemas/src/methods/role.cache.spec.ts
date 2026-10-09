import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { PermissionTypes, Permissions } from 'librechat-data-provider';
import type { IRole } from '..';
import { createRoleMethods } from './role';
import { createModels } from '../models';
import { tenantStorage } from '../config/tenantContext';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

/**
 * Real Map-backed cache. A jest.fn mock can only assert which key was passed;
 * a real store reproduces the actual collision: when two tenants write under the
 * same key, the second read serves the first tenant's value.
 */
function createMapCache() {
  const store = new Map<string, unknown>();
  return {
    store,
    get: async (k: string): Promise<unknown> => store.get(k),
    set: async (k: string, v: unknown): Promise<void> => {
      store.set(k, v);
    },
    del: async (k: string): Promise<void> => {
      store.delete(k);
    },
  };
}

const TENANT_A = 'tenant-aaaaaaaaaaaaaaaaaaaa';
const TENANT_B = 'tenant-bbbbbbbbbbbbbbbbbbbb';
const ROLE_NAME = 'EDITOR';

let mongoServer: MongoMemoryServer;
let Role: mongoose.Model<IRole>;
let cache: ReturnType<typeof createMapCache>;
let getRoleByName: ReturnType<typeof createRoleMethods>['getRoleByName'];

function runAs<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return tenantStorage.run({ tenantId }, fn);
}

function usePromptsPermission(role: IRole | null | undefined): boolean | undefined {
  const permissions = (role as unknown as { permissions?: Record<string, Record<string, boolean>> })
    ?.permissions;
  return permissions?.[PermissionTypes.PROMPTS]?.[Permissions.USE];
}

async function seedRole(tenantId: string, useValue: boolean): Promise<void> {
  await runAs(tenantId, async () => {
    await new Role({
      name: ROLE_NAME,
      permissions: { [PermissionTypes.PROMPTS]: { [Permissions.USE]: useValue } },
    }).save();
  });
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  Role = mongoose.models.Role as mongoose.Model<IRole>;
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await Role.deleteMany({});
  cache = createMapCache();
  const methods = createRoleMethods(mongoose, { getCache: () => cache });
  getRoleByName = methods.getRoleByName;
});

describe('getRoleByName cache is scoped to the active tenant', () => {
  it('does not serve one tenant a cached role belonging to another tenant', async () => {
    await seedRole(TENANT_A, true);
    await seedRole(TENANT_B, false);

    const roleA = await runAs(TENANT_A, () => getRoleByName(ROLE_NAME));
    expect(usePromptsPermission(roleA)).toBe(true);
    expect(cache.store.size).toBeGreaterThan(0);

    const roleB = await runAs(TENANT_B, () => getRoleByName(ROLE_NAME));
    expect(usePromptsPermission(roleB)).toBe(false);

    const roleAAgain = await runAs(TENANT_A, () => getRoleByName(ROLE_NAME));
    expect(usePromptsPermission(roleAAgain)).toBe(true);
  });

  it('appends the tenant id to the cache key', async () => {
    await seedRole(TENANT_A, true);
    await seedRole(TENANT_B, false);

    await runAs(TENANT_A, () => getRoleByName(ROLE_NAME));
    await runAs(TENANT_B, () => getRoleByName(ROLE_NAME));

    expect(cache.store.has(`${ROLE_NAME}:${TENANT_A}`)).toBe(true);
    expect(cache.store.has(`${ROLE_NAME}:${TENANT_B}`)).toBe(true);
    expect(cache.store.has(ROLE_NAME)).toBe(false);
  });

  it('serves the cached value within the same tenant without a second DB read', async () => {
    await seedRole(TENANT_A, true);

    const first = await runAs(TENANT_A, () => getRoleByName(ROLE_NAME));
    expect(usePromptsPermission(first)).toBe(true);

    const findOneSpy = jest.spyOn(Role, 'findOne');
    const second = await runAs(TENANT_A, () => getRoleByName(ROLE_NAME));
    expect(usePromptsPermission(second)).toBe(true);
    expect(findOneSpy).not.toHaveBeenCalled();
    findOneSpy.mockRestore();
  });

  it('uses the unscoped key when no tenant context is active (single-tenant)', async () => {
    const previousDefault = process.env.DEFAULT_TENANT_ID;
    delete process.env.DEFAULT_TENANT_ID;
    try {
      await seedRole(TENANT_A, true);

      const role = await getRoleByName(ROLE_NAME);
      expect(usePromptsPermission(role)).toBe(true);
      expect(cache.store.has(ROLE_NAME)).toBe(true);
      expect(cache.store.has(`${ROLE_NAME}:${TENANT_A}`)).toBe(false);
    } finally {
      if (previousDefault === undefined) {
        delete process.env.DEFAULT_TENANT_ID;
      } else {
        process.env.DEFAULT_TENANT_ID = previousDefault;
      }
    }
  });
});
