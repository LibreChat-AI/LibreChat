import { renderHook } from '@testing-library/react';
import { Permissions, PermissionTypes } from 'librechat-data-provider';
import type { MediaStartupConfig, TUser } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import { useMediaProviderKeyConfig } from '../useProviderKeys';
import { makeAuthContext, testUser } from 'test/auth';
import { AuthContext } from '~/hooks/AuthContext';

let mockUser: TUser | undefined;
let mockAuthenticated = true;
let mockCanUse = true;
let mockMediaEnabled = true;
let mockIntegrations: MediaStartupConfig['integrations'];
const mockAccess = jest.fn<boolean, [unknown]>(() => mockCanUse);

jest.mock('~/hooks', () => ({
  useHasAccess: (request: unknown) => mockAccess(request),
}));
jest.mock('~/data-provider', () => ({
  useGetEndpointsQuery: () => ({ data: {} }),
  useGetStartupConfig: () => ({
    data: {
      media: {
        enabled: mockMediaEnabled,
        integrations: mockIntegrations,
      },
    },
  }),
}));

function wrapper({ children }: { children: ReactNode }) {
  return (
    <AuthContext.Provider
      value={makeAuthContext({ user: mockUser, isAuthenticated: mockAuthenticated })}
    >
      {children}
    </AuthContext.Provider>
  );
}

describe('Media provider key access', () => {
  beforeEach(() => {
    mockUser = { ...testUser, tenantId: 'tenant' };
    mockAuthenticated = true;
    mockCanUse = true;
    mockMediaEnabled = true;
    mockIntegrations = [];
  });

  it('allows Media-only settings without requiring agent or generation permission', () => {
    const { result } = renderHook(() => useMediaProviderKeyConfig(), { wrapper });
    expect(result.current?.integrations).toBe(mockIntegrations);
    expect(mockAccess).toHaveBeenCalledWith({
      permissionType: PermissionTypes.MEDIA,
      permission: Permissions.USE,
    });
  });

  it.each(['signed out', 'no user', 'no permission', 'Media disabled'])(
    'does not expose Media settings when %s',
    (reason) => {
      if (reason === 'signed out') mockAuthenticated = false;
      if (reason === 'no user') mockUser = undefined;
      if (reason === 'no permission') mockCanUse = false;
      if (reason === 'Media disabled') mockMediaEnabled = false;
      const { result } = renderHook(() => useMediaProviderKeyConfig(), { wrapper });
      expect(result.current).toBeUndefined();
    },
  );

  it('updates the visible configuration and removes it when access is revoked', () => {
    const { result, rerender } = renderHook(() => useMediaProviderKeyConfig(), { wrapper });
    mockIntegrations = [
      {
        connectionId: 'personal',
        connectionName: 'Personal images',
        userKey: { keyName: 'Personal', encoding: 'apiKey', userProvideURL: false },
      },
    ];
    rerender();
    expect(result.current?.integrations).toBe(mockIntegrations);
    mockCanUse = false;
    rerender();
    expect(result.current).toBeUndefined();
  });
});
