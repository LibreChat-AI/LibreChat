import React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { AuthType, AgentCapabilities } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { VerifyToolAuthResponse } from 'librechat-data-provider';
import { useBuiltinAuthMap } from '../hooks';

const mockVerify = jest.fn();

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      getVerifyAgentToolAuth: () => mockVerify(),
    },
  };
});

jest.mock('librechat-data-provider/react-query', () => ({
  useUpdateUserPluginsMutation: () => ({ mutate: jest.fn() }),
}));

jest.mock('@librechat/client', () => ({ useToastContext: () => ({ showToast: jest.fn() }) }));
jest.mock('~/hooks', () => ({
  useLocalize: () => (k: string) => k,
  useHasAccess: () => true,
  useHasMemoryAccess: () => true,
}));
jest.mock('~/hooks/AuthContext', () => ({ useAuthContext: () => ({ user: { id: 'u1' } }) }));
jest.mock('~/Providers', () => ({ useAgentPanelContext: () => ({}) }));

function wrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

const WEB_SEARCH = AgentCapabilities.web_search;

describe('useBuiltinAuthMap', () => {
  beforeEach(() => mockVerify.mockReset());

  test('flags web_search needs_setup while verification is still loading', () => {
    mockVerify.mockReturnValue(new Promise<VerifyToolAuthResponse>(() => undefined));
    const { result } = renderHook(() => useBuiltinAuthMap(), { wrapper: wrapper() });
    expect(result.current.get(WEB_SEARCH)).toBe(true);
  });

  test('keeps the flag for an unsatisfied user-provided key', async () => {
    mockVerify.mockResolvedValue({
      authenticated: false,
      authTypes: [['serpapi', AuthType.USER_PROVIDED]],
    });
    const { result } = renderHook(() => useBuiltinAuthMap(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.get(WEB_SEARCH)).toBe(true));
  });

  test('clears the flag once a user-provided key is satisfied', async () => {
    mockVerify.mockResolvedValue({
      authenticated: true,
      authTypes: [['serpapi', AuthType.USER_PROVIDED]],
    });
    const { result } = renderHook(() => useBuiltinAuthMap(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.has(WEB_SEARCH)).toBe(false));
  });

  test('clears the flag for a system-defined deployment (no key needed)', async () => {
    mockVerify.mockResolvedValue({
      authenticated: true,
      authTypes: [['serpapi', AuthType.SYSTEM_DEFINED]],
    });
    const { result } = renderHook(() => useBuiltinAuthMap(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.has(WEB_SEARCH)).toBe(false));
  });
});
