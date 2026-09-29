import React from 'react';
import { RecoilRoot } from 'recoil';
import { renderHook } from '@testing-library/react';
import { PermissionTypes, Permissions } from 'librechat-data-provider';
import type { TUser } from 'librechat-data-provider';

type CloudFrontRetryOptions = { getAuthorizationHeader: () => string | undefined };

const mockUseHasAccess = jest.fn();
const mockUseMCPServersQuery = jest.fn();
const mockUseMCPToolsQuery = jest.fn();
const mockUseCatalogReady = jest.fn();
const mockInstallCloudFrontImageRetry = jest.fn(
  (_startupConfig: unknown, _options: CloudFrontRetryOptions): (() => void) =>
    () =>
      undefined,
);
const mockGetTokenHeader = jest.fn();

jest.mock('@librechat/client', () => ({
  installCloudFrontImageRetry: (startupConfig: unknown, options: CloudFrontRetryOptions) =>
    mockInstallCloudFrontImageRetry(startupConfig, options),
}));

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    getTokenHeader: () => mockGetTokenHeader(),
  };
});

jest.mock('~/hooks', () => ({
  useHasAccess: (args: unknown) => mockUseHasAccess(args),
  useCatalogReady: (id: unknown) => mockUseCatalogReady(id),
}));

jest.mock('~/data-provider', () => ({
  useMCPServersQuery: (config: unknown) => mockUseMCPServersQuery(config),
  useMCPToolsQuery: (config: unknown) => mockUseMCPToolsQuery(config),
}));

jest.mock('../useSpeechSettingsInit', () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock('~/utils/timestamps', () => ({
  cleanupTimestampedStorage: jest.fn(),
}));

jest.mock('react-gtm-module', () => ({
  __esModule: true,
  default: { initialize: jest.fn() },
}));

import useAppStartup from '../useAppStartup';

const mockUser = {
  id: 'user-123',
  username: 'testuser',
  email: 'test@example.com',
  name: 'Test User',
  avatar: '',
  role: 'USER',
  provider: 'local',
  emailVerified: true,
  createdAt: '2023-01-01T00:00:00.000Z',
  updatedAt: '2023-01-01T00:00:00.000Z',
} as TUser;

const wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <RecoilRoot>{children}</RecoilRoot>
);
describe('useAppStartup: MCP permission gating', () => {
  beforeEach(() => {
    mockInstallCloudFrontImageRetry.mockClear();
    mockUseMCPServersQuery.mockReturnValue({ data: undefined, isLoading: false });
    mockUseCatalogReady.mockReturnValue(true);
  });

  it('checks the MCP_SERVERS.USE permission via useHasAccess', () => {
    mockUseHasAccess.mockReturnValue(false);

    renderHook(() => useAppStartup({ startupConfig: undefined, user: mockUser }), {
      wrapper,
    });

    expect(mockUseHasAccess).toHaveBeenCalledWith({
      permissionType: PermissionTypes.MCP_SERVERS,
      permission: Permissions.USE,
    });
  });

  it('suppresses the MCP server query when user lacks MCP_SERVERS.USE', () => {
    mockUseHasAccess.mockReturnValue(false);

    renderHook(() => useAppStartup({ startupConfig: undefined, user: mockUser }), { wrapper });

    expect(mockUseMCPServersQuery).toHaveBeenCalledWith({ enabled: false });
  });

  it('suppresses server metadata warmup until the catalog is released', () => {
    mockUseHasAccess.mockReturnValue(true);
    mockUseCatalogReady.mockReturnValue(false);

    renderHook(() => useAppStartup({ startupConfig: undefined, user: mockUser }), { wrapper });

    expect(mockUseCatalogReady).toHaveBeenCalledWith('mcpServers');
    expect(mockUseMCPServersQuery).toHaveBeenCalledWith({ enabled: false });
  });

  it('warms server metadata without discovering MCP tools during app startup', () => {
    mockUseHasAccess.mockReturnValue(true);

    renderHook(() => useAppStartup({ startupConfig: undefined, user: mockUser }), { wrapper });

    expect(mockUseMCPServersQuery).toHaveBeenCalledWith({ enabled: true });
    expect(mockUseMCPToolsQuery).not.toHaveBeenCalled();
  });

  it('installs CloudFront image retry from startup config', () => {
    mockUseHasAccess.mockReturnValue(false);
    const startupConfig = {
      cloudFront: {
        cookieRefresh: {
          endpoint: '/api/auth/cloudfront/refresh',
          domain: 'https://cdn.example.com',
        },
      },
    } as never;

    renderHook(() => useAppStartup({ startupConfig, user: mockUser }), {
      wrapper,
    });

    expect(mockInstallCloudFrontImageRetry).toHaveBeenCalledWith(startupConfig, {
      getAuthorizationHeader: expect.any(Function),
    });
    const [, options] = mockInstallCloudFrontImageRetry.mock.calls[0];
    mockGetTokenHeader.mockReturnValue('Bearer app-token');

    expect(options.getAuthorizationHeader()).toBe('Bearer app-token');
    expect(mockGetTokenHeader).toHaveBeenCalledTimes(1);
  });
});
