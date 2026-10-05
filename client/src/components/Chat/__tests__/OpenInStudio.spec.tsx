import React from 'react';
import { RecoilRoot } from 'recoil';
import { Provider, createStore } from 'jotai';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { TAuthContext, TMediaFileRef } from '~/common';
import {
  mediaDraftFamily,
  mediaLibraryFamily,
  clearMediaSessionStorage,
} from '~/components/Media/state';
import { StudioProvider, useStudioAvailable } from '~/components/Chat/Studio';
import { makeAuthContext, makeStartupConfig, testUser } from 'test/auth';
import { mediaSessionScope } from '~/components/Media/session';
import { startupConfigKey } from '~/data-provider';
import { AuthContext } from '~/hooks/AuthContext';
import { ShareContext } from '~/Providers';
import OpenInStudio from '../Media/Open';
import store from '~/store';

const file: TMediaFileRef = {
  file_id: 'generated',
  filename: 'generated.png',
  filepath: '/images/user/generated.png',
  type: 'image/png',
  bytes: 500,
  width: 1024,
  height: 1024,
};

function Gate() {
  return <output data-testid="gate">{String(useStudioAvailable())}</output>;
}

const clients: QueryClient[] = [];
function mount({
  auth = makeAuthContext(),
  config = makeStartupConfig(),
  shareId,
  temporary = false,
  target = file,
}: {
  auth?: TAuthContext;
  config?: ReturnType<typeof makeStartupConfig>;
  shareId?: string;
  temporary?: boolean;
  target?: TMediaFileRef;
} = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, cacheTime: 0 } } });
  clients.push(client);
  client.setQueryData(startupConfigKey(false), config);
  const jotai = createStore();
  render(
    <QueryClientProvider client={client}>
      <RecoilRoot initializeState={({ set }) => set(store.isTemporary, temporary)}>
        <MemoryRouter initialEntries={['/c/chat']}>
          <Provider store={jotai}>
            <AuthContext.Provider value={auth}>
              <ShareContext.Provider value={{ shareId }}>
                <StudioProvider>
                  <Gate />
                  <Routes>
                    <Route path="/c/:id" element={<OpenInStudio file={target} />} />
                    <Route path="/studio" element={<output data-testid="studio-route" />} />
                  </Routes>
                </StudioProvider>
              </ShareContext.Provider>
            </AuthContext.Provider>
          </Provider>
        </MemoryRouter>
      </RecoilRoot>
    </QueryClientProvider>,
  );
  return { jotai };
}
beforeEach(() => clearMediaSessionStorage());
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
});

test('offers Studio to a signed-in, permitted reader of a regular chat', () => {
  mount();
  expect(screen.getByTestId('gate')).toHaveTextContent('true');
  expect(screen.getByRole('button', { name: 'Open in Media Studio' })).toBeInTheDocument();
});

test.each([
  ['a shared conversation', { shareId: 'share' }],
  ['a temporary chat', { temporary: true }],
  ['a role without media access', { auth: makeAuthContext({}, { use: false }) }],
  ['a signed-out visitor', { auth: makeAuthContext({ isAuthenticated: false }) }],
  ['Studio switched off', { config: makeStartupConfig({ studio: false }) }],
])('withholds Studio in %s', (_label, options) => {
  mount(options);
  expect(screen.getByTestId('gate')).toHaveTextContent('false');
});

test('renders nothing for a file that does not describe a usable asset', () => {
  mount({ target: { file_id: 'generated', filename: 'generated.png' } });
  expect(screen.getByTestId('gate')).toHaveTextContent('true');
  expect(screen.queryByRole('button', { name: 'Open in Media Studio' })).not.toBeInTheDocument();
});

test('seeds the new-creation draft with the image as a reference and opens Studio', () => {
  const env = mount();
  const draft = mediaDraftFamily(`${mediaSessionScope(testUser)}:new`);
  expect(env.jotai.get(draft).assets).toEqual([]);
  fireEvent.click(screen.getByRole('button', { name: 'Open in Media Studio' }));
  expect(env.jotai.get(draft)).toMatchObject({
    operation: 'image.edit',
    revision: 1,
    inputs: [{ role: 'reference', file_id: 'generated' }],
    assets: [{ file_id: 'generated', filepath: file.filepath, width: 1024, height: 1024 }],
  });
  expect(screen.getByTestId('studio-route')).toBeInTheDocument();
});

test('opens the seeded editor even when Studio last showed the gallery', () => {
  const env = mount();
  const library = mediaLibraryFamily(mediaSessionScope(testUser));
  env.jotai.set(library, (previous) => ({ ...previous, view: 'gallery', threadId: undefined }));
  fireEvent.click(screen.getByRole('button', { name: 'Open in Media Studio' }));
  expect(env.jotai.get(library).view).toBe('thread');
  expect(screen.getByTestId('studio-route')).toBeInTheDocument();
});
