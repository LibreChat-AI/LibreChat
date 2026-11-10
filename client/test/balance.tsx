import { RecoilRoot } from 'recoil';
import axios, { AxiosHeaders } from 'axios';
import { Provider, createStore } from 'jotai';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TBalanceResponse, TUser } from 'librechat-data-provider';
import type { AxiosResponse } from 'axios';
import type { ReactNode } from 'react';
import type { TAuthContext } from '~/common';
import { AuthContext } from '~/hooks/AuthContext';
import store from '~/store';

export const balance: TBalanceResponse = {
  tokenCredits: 3_100_000,
  autoRefillEnabled: true,
  refillAmount: 5_000_000,
  refillIntervalValue: 7,
  refillIntervalUnit: 'days',
  lastRefill: '2026-07-01T00:00:00.000Z',
};
const user: TUser = {
  id: 'usage-user',
  username: 'usage-user',
  email: 'usage@example.com',
  name: 'Usage User',
  avatar: '',
  role: 'USER',
  provider: 'local',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
const auth: TAuthContext = {
  user,
  token: undefined,
  isAuthenticated: true,
  isAuthReady: true,
  error: undefined,
  login: jest.fn(),
  logout: jest.fn(),
  completeAuthentication: jest.fn(),
  setError: jest.fn(),
};
/** Legacy admin values can bypass the validated config schema. */
export const config = ({
  balanceEnabled = true,
  display = 'credits',
}: { balanceEnabled?: boolean; display?: string } = {}) => ({
  balance: { enabled: balanceEnabled, startBalance: 20_000, display },
  interface: { contextUsage: false, currency: { code: 'USD', rate: 1 } },
});
export function response<T>(data: T): AxiosResponse<T> {
  return {
    data,
    status: 200,
    statusText: 'OK',
    headers: {},
    config: { headers: new AxiosHeaders() },
  };
}
export function deferred<T>() {
  let resolve!: (value: AxiosResponse<T>) => void;
  const promise = new Promise<AxiosResponse<T>>((done) => {
    resolve = done;
  });
  return { promise, resolve: (data: T) => resolve(response(data)) };
}

export function createBalanceTestHarness({ jotaiStore = createStore() } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, cacheTime: 0 } } });
  const state = { authenticated: true, queriesEnabled: true };
  const getConfig = jest
    .fn<Promise<AxiosResponse<ReturnType<typeof config>>>, []>()
    .mockResolvedValue(response(config()));
  const getBalance = jest
    .fn<Promise<AxiosResponse<TBalanceResponse | null>>, []>()
    .mockResolvedValue(response(balance));
  jest.spyOn(axios, 'get').mockImplementation((url) => {
    if (url === '/api/config') return getConfig();
    if (url === '/api/balance') return getBalance();
    throw new Error(`Unexpected GET ${url}`);
  });
  function Wrapper({ children }: { children: ReactNode }) {
    const currentUser = state.authenticated ? user : undefined;
    return (
      <QueryClientProvider client={client}>
        <RecoilRoot
          initializeState={({ set }) => {
            set(store.user, currentUser);
            set(store.queriesEnabled, state.queriesEnabled);
          }}
        >
          <Provider store={jotaiStore}>
            <AuthContext.Provider
              value={{ ...auth, user: currentUser, isAuthenticated: state.authenticated }}
            >
              {children}
            </AuthContext.Provider>
          </Provider>
        </RecoilRoot>
      </QueryClientProvider>
    );
  }
  return { client, state, getConfig, getBalance, Wrapper };
}
