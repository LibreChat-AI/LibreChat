import React from 'react';
import { RecoilRoot } from 'recoil';
import { MemoryRouter } from 'react-router-dom';
import { dataService } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TAuthContext } from '~/common';
import { makeAuthContext, makeStartupConfig } from 'test/auth';
import { startupConfigKey } from '~/data-provider';
import { AuthContext } from '~/hooks/AuthContext';
import Studio from '../Studio';

jest.mock('librechat-data-provider', () => {
  const actual =
    jest.requireActual<typeof import('librechat-data-provider')>('librechat-data-provider');
  return { ...actual, dataService: { ...actual.dataService } };
});

const clients: QueryClient[] = [];
function mount(auth: TAuthContext, seed?: ReturnType<typeof makeStartupConfig>) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, cacheTime: 0 } },
    logger: { log: console.log, warn: console.warn, error: () => {} },
  });
  clients.push(client);
  if (seed) client.setQueryData(startupConfigKey(false), seed);
  return render(
    <QueryClientProvider client={client}>
      <RecoilRoot>
        <MemoryRouter initialEntries={['/studio']}>
          <AuthContext.Provider value={auth}>
            <Studio />
          </AuthContext.Provider>
        </MemoryRouter>
      </RecoilRoot>
    </QueryClientProvider>,
  );
}
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  jest.restoreAllMocks();
});

test('shows the loading skeleton until the session is ready', () => {
  mount(makeAuthContext({ isAuthReady: false }), makeStartupConfig());
  const status = screen.getByRole('status');
  expect(screen.getByRole('heading', { name: 'Media Studio' })).toBeVisible();
  expect(status).toHaveTextContent('Loading media…');
});

test('reports a startup config failure and retries into the unavailable state', async () => {
  const load = jest
    .spyOn(dataService, 'getStartupConfig')
    .mockRejectedValueOnce(new Error('down'))
    .mockResolvedValueOnce(makeStartupConfig(null));
  mount(makeAuthContext());
  expect(await screen.findByText('Media could not be loaded. Retry to refresh.')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(
    await screen.findByText('Media Studio is unavailable for this account.'),
  ).toBeInTheDocument();
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
});

test.each([
  ['the deployment has no media config', makeAuthContext(), makeStartupConfig(null)],
  ['Studio is switched off', makeAuthContext(), makeStartupConfig({ studio: false })],
  ['the role lacks media access', makeAuthContext({}, { use: false }), makeStartupConfig()],
  ['the visitor is signed out', makeAuthContext({ isAuthenticated: false }), makeStartupConfig()],
])('is unavailable when %s', (_label, auth, config) => {
  mount(auth, config);
  expect(screen.getByRole('status')).toHaveTextContent(
    'Media Studio is unavailable for this account.',
  );
});
