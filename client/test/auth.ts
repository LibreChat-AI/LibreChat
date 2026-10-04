import { Permissions, PermissionTypes, SystemRoles, roleSchema } from 'librechat-data-provider';
import type { MediaStartupConfig, TRole, TStartupConfig, TUser } from 'librechat-data-provider';
import type { TAuthContext } from '~/common';

export const testUser = {
  id: 'user',
  role: SystemRoles.USER,
  username: 'user',
  email: 'user@example.com',
  name: 'User',
  avatar: '',
  provider: 'local',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
} as TUser;

/** A role parsed through the real schema so every permission group carries its defaults;
 *  only the Media grants vary. */
export function makeRole(media: { use?: boolean; create?: boolean } = {}): TRole {
  const groups = Object.fromEntries(Object.values(PermissionTypes).map((type) => [type, {}]));
  return roleSchema.parse({
    name: SystemRoles.USER,
    permissions: {
      ...groups,
      [PermissionTypes.MEDIA]: {
        [Permissions.USE]: media.use ?? true,
        [Permissions.CREATE]: media.create ?? true,
      },
    },
  });
}

export function makeAuthContext(
  overrides: Partial<TAuthContext> = {},
  media: { use?: boolean; create?: boolean } = {},
): TAuthContext {
  return {
    user: testUser,
    token: 'token',
    isAuthenticated: true,
    isAuthReady: true,
    error: undefined,
    login: () => {},
    logout: () => {},
    completeAuthentication: () => {},
    setError: () => {},
    roles: { [SystemRoles.USER]: makeRole(media) },
    ...overrides,
  };
}

/** Startup config carrying only what the media surfaces read; `null` leaves media unconfigured. */
export function makeStartupConfig(media: Partial<MediaStartupConfig> | null = {}): TStartupConfig {
  const base = {} as TStartupConfig;
  if (media === null) return base;
  return {
    ...base,
    media: {
      enabled: true,
      studio: true,
      chat: true,
      canCreate: true,
      clientPollIntervalMs: 5000,
      clientCatchUpIntervalMs: 60000,
      ...media,
    },
  };
}
