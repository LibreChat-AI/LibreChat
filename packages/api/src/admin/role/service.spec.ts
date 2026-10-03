import type { IRole } from '@librechat/data-schemas';
import { createRoleAdminService, validateRoleMetadata } from './service';

const role = { name: 'BETA', permissions: {} } as IRole;

function createDeps() {
  return {
    getRoleByName: jest.fn(async () => role as IRole | null),
    createRoleByName: jest.fn(async () => role),
    updateRoleByName: jest.fn(async () => role as IRole | null),
    findConfigByPrincipal: jest.fn(async () => null),
    upsertConfig: jest.fn(async () => null),
    clearConfigTombstones: jest.fn(async () => undefined),
    invalidateConfigCaches: jest.fn(async () => undefined),
  };
}

describe('role admin service', () => {
  it('reuses Admin API metadata validation for deployment preflight', () => {
    expect(() => validateRoleMetadata('members')).toThrow('reserved path segment');
    expect(() => validateRoleMetadata('BETA', 'x'.repeat(2001))).toThrow(
      'description must not exceed 2000 characters',
    );
  });

  it('creates a normalized role', async () => {
    const deps = createDeps();
    const service = createRoleAdminService(deps);

    await service.createRole({ name: ' BETA ', permissions: {} });

    expect(deps.createRoleByName).toHaveBeenCalledWith({ name: 'BETA', permissions: {} });
  });

  it('updates role metadata', async () => {
    const deps = createDeps();
    const service = createRoleAdminService(deps);

    await service.updateRole('BETA', { description: 'Beta users' });

    expect(deps.updateRoleByName).toHaveBeenCalledWith('BETA', { description: 'Beta users' });
  });

  it('replaces permissions supplied to updateRole', async () => {
    const deps = createDeps();
    const service = createRoleAdminService(deps);

    await service.updateRole('BETA', { permissions: { AGENTS: { USE: true } } });

    expect(deps.updateRoleByName).toHaveBeenCalledWith('BETA', {
      permissions: { AGENTS: { USE: true } },
    });
  });

  it('prepares and stores role config, then invalidates caches', async () => {
    const deps = createDeps();
    const service = createRoleAdminService(deps);

    await service.upsertRoleConfig('BETA', {
      priority: 10,
      overrides: { filters: {}, memory: { disabled: false } },
    });

    expect(deps.upsertConfig).toHaveBeenCalledWith(
      expect.anything(),
      'BETA',
      expect.anything(),
      { memory: { disabled: false } },
      10,
    );
    expect(deps.invalidateConfigCaches).toHaveBeenCalledTimes(1);
    expect(deps.clearConfigTombstones).toHaveBeenCalledWith(expect.anything(), 'BETA');
  });

  it('invalidates config caches when clearing tombstones fails', async () => {
    const deps = createDeps();
    deps.clearConfigTombstones.mockRejectedValueOnce(new Error('tombstone update failed'));
    const service = createRoleAdminService(deps);

    await expect(service.upsertRoleConfig('BETA', { priority: 10, overrides: {} })).rejects.toThrow(
      'tombstone update failed',
    );
    expect(deps.invalidateConfigCaches).toHaveBeenCalledTimes(1);
  });

  it('rejects names that are invalid in the Admin API', async () => {
    const deps = createDeps();
    const service = createRoleAdminService(deps);

    await expect(service.createRole({ name: 'members', permissions: {} })).rejects.toThrow(
      'reserved path segment',
    );
    expect(deps.createRoleByName).not.toHaveBeenCalled();
  });
});
