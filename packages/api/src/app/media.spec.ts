import {
  FileSources,
  PermissionTypes,
  Permissions,
  resolveMediaConfig,
} from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import { updateInterfacePermissions } from './permissions';

describe('media permission migration', () => {
  const getRoleByName = jest.fn();
  const updateAccessPermissions = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    getRoleByName.mockResolvedValue(null);
  });

  const appConfig = (intent?: { use?: boolean; create?: boolean }): AppConfig => ({
    config: { interface: { media: intent } },
    interfaceConfig: { media: intent },
    fileStrategy: FileSources.local,
    imageOutputType: 'png',
    media: resolveMediaConfig(),
  });

  it('seeds missing media permissions from role defaults without enabling existing image tools', async () => {
    await updateInterfacePermissions({
      appConfig: appConfig(),
      getRoleByName,
      updateAccessPermissions,
    });
    expect(updateAccessPermissions).toHaveBeenCalledTimes(2);
    expect(
      Object.fromEntries(
        updateAccessPermissions.mock.calls.map((call) => [call[0], call[1][PermissionTypes.MEDIA]]),
      ),
    ).toEqual({
      USER: { [Permissions.USE]: false, [Permissions.CREATE]: false },
      ADMIN: { [Permissions.USE]: true, [Permissions.CREATE]: true },
    });
  });

  it('preserves stored denials and grants through disabled runtime config', async () => {
    getRoleByName.mockResolvedValue({
      name: 'USER',
      permissions: { MEDIA: { USE: true, CREATE: false } },
    });
    await updateInterfacePermissions({
      appConfig: appConfig(),
      getRoleByName,
      updateAccessPermissions,
    });
    for (const call of updateAccessPermissions.mock.calls) {
      expect(call[1][PermissionTypes.MEDIA]).toBeUndefined();
    }
  });

  it('applies only explicitly configured bits and leaves unmentioned bits untouched', async () => {
    getRoleByName.mockResolvedValue({
      name: 'USER',
      permissions: { MEDIA: { USE: false, CREATE: true } },
    });
    await updateInterfacePermissions({
      appConfig: appConfig({ use: true }),
      getRoleByName,
      updateAccessPermissions,
    });
    for (const call of updateAccessPermissions.mock.calls) {
      expect(call[1][PermissionTypes.MEDIA]).toEqual({ [Permissions.USE]: true });
    }
    updateAccessPermissions.mockClear();
    getRoleByName.mockResolvedValue({ name: 'USER', permissions: { MEDIA: { USE: true } } });
    await updateInterfacePermissions({
      appConfig: appConfig(),
      getRoleByName,
      updateAccessPermissions,
    });
    for (const call of updateAccessPermissions.mock.calls) {
      expect(call[1][PermissionTypes.MEDIA]).toBeUndefined();
    }
  });
});
