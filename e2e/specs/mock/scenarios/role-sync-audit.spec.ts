import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { SystemRoles, PermissionTypes, Permissions } from 'librechat-data-provider';
import {
  createModels,
  createMethods,
  tenantStorage,
  loadDefaultInterface,
} from '@librechat/data-schemas';
import type {
  IRole,
  AppConfig,
  AllMethods,
  CacheStore,
  RecordAuditEntryInput,
} from '@librechat/data-schemas';
import type { TCustomConfig, TConfigDefaults } from 'librechat-data-provider';
import { updateInterfacePermissions } from '../../../../packages/api/src/app/permissions';
import { getMongoUri, withMongo } from '../db';

/**
 * Startup syncs the USER and ADMIN roles from `interface` and records a `role.synced` entry
 * for each role whose stored permissions changed. The roles here live in a tenant partition of
 * their own, so the platform roles every other spec signs in with are never written.
 */

type Sync = Parameters<typeof updateInterfacePermissions>[0];

const tenantId = `e2e-role-sync-${randomUUID()}`;
let methods: AllMethods;

/** A serializing role cache, as Redis is, whose writes can be made to fail. */
function createRoleCache() {
  const entries = new Map<string, string>();
  const state = { failWrites: false };
  const store: CacheStore = {
    get: async (key) => {
      const entry = entries.get(key);
      return entry === undefined ? undefined : JSON.parse(entry);
    },
    set: async (key, value) => {
      if (state.failWrites) {
        throw new Error('role cache unavailable');
      }
      entries.set(key, JSON.stringify(value));
      return true;
    },
  };
  return { store, state };
}

async function storedBookmarksUse(name: string): Promise<boolean | undefined> {
  const role = await withMongo((db) => db.collection<IRole>('roles').findOne({ name, tenantId }));
  const permissions = role?.permissions as Record<string, Record<string, boolean>> | undefined;
  return permissions?.[PermissionTypes.BOOKMARKS]?.[Permissions.USE];
}

async function syncRoles(
  config: Partial<TCustomConfig>,
  roleMethods: Pick<AllMethods, 'getRoleByName' | 'getPartitionRole' | 'updateAccessPermissions'>,
): Promise<RecordAuditEntryInput[]> {
  const configDefaults = { interface: {} } as TConfigDefaults;
  const interfaceConfig = await loadDefaultInterface({ config, configDefaults });
  const appConfig = { config, interfaceConfig } as unknown as AppConfig;
  const entries: RecordAuditEntryInput[] = [];
  await updateInterfacePermissions({
    appConfig,
    tenantId,
    getRoleByName: roleMethods.getRoleByName,
    /* The method takes a narrower update type than the sync passes; startup wires it from JS. */
    updateAccessPermissions: roleMethods.updateAccessPermissions as Sync['updateAccessPermissions'],
    getPartitionRole: roleMethods.getPartitionRole,
    recordAuditEntry: async (entry) => {
      entries.push(entry);
    },
  });
  return entries;
}

test.beforeAll(async () => {
  const uri = getMongoUri();
  /* The local mock run uses LibreChat-e2e and the verification runner a per-run lc_verify_*
   * database; anything else is a real deployment, and this spec writes role documents. */
  if (!/\/(LibreChat-e2e|lc_verify_[A-Za-z0-9_]+)(?:\?|$)/.test(uri)) {
    throw new Error('Role sync acceptance requires a disposable E2E Mongo database');
  }
  await mongoose.connect(uri);
  createModels(mongoose);
  methods = createMethods(mongoose);
});

test.afterAll(async () => {
  await withMongo((db) => db.collection('roles').deleteMany({ tenantId }));
  await mongoose.disconnect();
});

test.describe('startup role sync audit', () => {
  test('a sync whose role cache write fails after the database write is still audited @scenario:role-sync-audited-when-cache-write-fails', async () => {
    const cache = createRoleCache();
    const roles = createMethods(mongoose, { getCache: () => cache.store });
    /* Both roles are read once with a working cache, so it holds their pre-sync documents. */
    await tenantStorage.run({ tenantId }, async () => {
      await roles.getRoleByName(SystemRoles.USER);
      await roles.getRoleByName(SystemRoles.ADMIN);
    });
    expect(await storedBookmarksUse(SystemRoles.USER)).not.toBe(false);

    cache.state.failWrites = true;
    const entries = await syncRoles({ interface: { bookmarks: false } }, roles);

    /* The write committed while the cache kept the pre-sync role. */
    expect(await storedBookmarksUse(SystemRoles.USER)).toBe(false);
    const cached = await tenantStorage.run({ tenantId }, () =>
      roles.getRoleByName(SystemRoles.USER),
    );
    const cachedPermissions = cached.permissions as Record<string, Record<string, boolean>>;
    expect(cachedPermissions[PermissionTypes.BOOKMARKS]?.[Permissions.USE]).not.toBe(false);

    const userEntry = entries.find((entry) => entry.target?.id === SystemRoles.USER);
    expect(userEntry).toEqual(
      expect.objectContaining({
        action: 'role.synced',
        tenantId,
        actor: { type: 'system', name: 'librechat.yaml interface sync' },
        metadata: expect.objectContaining({
          changes: expect.stringContaining('BOOKMARKS.USE=false'),
        }),
      }),
    );
  });

  test('a sync that changes no stored permission records nothing @scenario:role-sync-without-changes-is-not-audited', async () => {
    await tenantStorage.run({ tenantId }, async () => {
      await methods.getRoleByName(SystemRoles.USER);
      await methods.getRoleByName(SystemRoles.ADMIN);
    });
    await syncRoles({ interface: { bookmarks: false } }, methods);

    const entries = await syncRoles({ interface: { bookmarks: false } }, methods);

    expect(await storedBookmarksUse(SystemRoles.USER)).toBe(false);
    expect(entries).toEqual([]);
  });
});
