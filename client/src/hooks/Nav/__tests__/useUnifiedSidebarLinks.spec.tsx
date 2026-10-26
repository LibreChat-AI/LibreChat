import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { renderHook } from '@testing-library/react';
import useUnifiedSidebarLinks from '../useUnifiedSidebarLinks';

const mockStartupConfig = jest.fn();
const mockInsightsAccess = jest.fn();

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => mockStartupConfig(),
  useGetEndpointsQuery: () => ({ data: {} }),
  useInsightsAccessQuery: (...args: unknown[]) => mockInsightsAccess(...args),
}));

jest.mock('~/hooks', () => ({
  useAuthContext: () => ({ user: { id: 'user-1' } }),
}));

jest.mock('librechat-data-provider/react-query', () => ({
  useUserKeyQuery: () => ({ data: {} }),
}));

jest.mock('recoil', () => ({ useRecoilValue: () => null }));
jest.mock('~/store', () => ({
  __esModule: true,
  default: { conversationEndpointByIndex: () => null },
}));
jest.mock('~/hooks/Nav/useSideNavLinks', () => ({
  __esModule: true,
  default: () => [],
}));
jest.mock('~/components/UnifiedSidebar/ConversationsSection', () => ({
  __esModule: true,
  default: () => null,
}));

function wrapper({ children }: { children: React.ReactNode }) {
  return <MemoryRouter initialEntries={['/c/new']}>{children}</MemoryRouter>;
}

describe('Insights sidebar availability', () => {
  beforeEach(() => {
    mockStartupConfig.mockReturnValue({ data: { insightsEnabled: true } });
    mockInsightsAccess.mockReturnValue({ data: { access: true }, isLoading: false });
  });

  it('shows Insights when effective startup enablement and agent access allow it', () => {
    const { result } = renderHook(() => useUnifiedSidebarLinks(), { wrapper });

    expect(result.current.some((link) => link.id === 'insights')).toBe(true);
    expect(mockInsightsAccess).toHaveBeenCalledWith('user-1', { enabled: true });
  });

  it('hides Insights and skips its access probe when startup disables it, even with cached access', () => {
    mockStartupConfig.mockReturnValue({ data: { insightsEnabled: false } });
    const { result } = renderHook(() => useUnifiedSidebarLinks(), { wrapper });

    expect(result.current.some((link) => link.id === 'insights')).toBe(false);
    expect(mockInsightsAccess).toHaveBeenCalledWith('user-1', { enabled: false });
  });

  it('keeps Insights hidden when the user lacks agent access', () => {
    mockInsightsAccess.mockReturnValue({ data: { access: false }, isLoading: false });
    const { result } = renderHook(() => useUnifiedSidebarLinks(), { wrapper });

    expect(result.current.some((link) => link.id === 'insights')).toBe(false);
  });
});
