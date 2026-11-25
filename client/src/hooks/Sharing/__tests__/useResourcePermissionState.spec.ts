import { renderHook } from '@testing-library/react';
import { AccessRoleIds, PrincipalType, ResourceType } from 'librechat-data-provider';
import { useResourcePermissionState } from '../useResourcePermissionState';

const mockUseGetResourcePermissionsQuery = jest.fn();
const mockUseUpdateResourcePermissionsMutation = jest.fn();

jest.mock('librechat-data-provider/react-query', () => ({
  useGetResourcePermissionsQuery: (...args: unknown[]) =>
    mockUseGetResourcePermissionsQuery(...args),
  useUpdateResourcePermissionsMutation: () => mockUseUpdateResourcePermissionsMutation(),
}));

jest.mock('~/utils', () => {
  const { AccessRoleIds: roleIds } = jest.requireActual('librechat-data-provider');
  return {
    getResourceConfig: () => ({ defaultViewerRoleId: roleIds.AGENT_VIEWER }),
  };
});

describe('useResourcePermissionState', () => {
  beforeEach(() => {
    mockUseUpdateResourcePermissionsMutation.mockReturnValue({ mutateAsync: jest.fn() });
    mockUseGetResourcePermissionsQuery.mockReturnValue({
      data: {
        principals: [
          {
            type: PrincipalType.ROLE,
            id: 'role-with-insights',
            accessRoleId: AccessRoleIds.AGENT_VIEWER,
            viewInsights: true,
          },
          {
            type: PrincipalType.ROLE,
            id: 'role-without-insights',
            accessRoleId: AccessRoleIds.AGENT_VIEWER,
            viewInsights: false,
          },
        ],
      },
      isLoading: false,
      isFetching: false,
      error: null,
      refetch: jest.fn(),
    });
  });

  it('preserves Insights access in the persisted-share snapshot', () => {
    const { result } = renderHook(() =>
      useResourcePermissionState(ResourceType.AGENT, 'agent-db-id', true),
    );

    expect(result.current.currentShares).toEqual([
      expect.objectContaining({ id: 'role-with-insights', viewInsights: true }),
      expect.objectContaining({ id: 'role-without-insights', viewInsights: false }),
    ]);
  });
});
