import React from 'react';
import { RecoilRoot } from 'recoil';
import { Provider, createStore } from 'jotai';
import { MemoryRouter } from 'react-router-dom';
import { QueryKeys } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { MediaAsset, TConversation } from 'librechat-data-provider';
import type { ExtendedFile } from '~/common';
import { makeAuthContext, makeStartupConfig, testUser } from 'test/auth';
import { clearMediaSessionStorage } from '~/components/Media/state';
import { mediaSessionScope } from '~/components/Media/session';
import { mediaChatHandoff } from '~/components/Media/handoff';
import { startupConfigKey } from '~/data-provider';
import { AuthContext } from '~/hooks/AuthContext';
import ChatMedia from '../Media';

const conversation = { endpoint: 'openAI', conversationId: 'chat' } as TConversation;
const image: MediaAsset = {
  file_id: 'generated',
  filename: 'generated.png',
  filepath: '/images/user/generated.png',
  type: 'image/png',
  bytes: 5000,
};
const attached: ExtendedFile = {
  file_id: 'earlier',
  filename: 'earlier.png',
  filepath: '/images/user/earlier.png',
  type: 'image/png',
  size: 10,
  progress: 1,
};
const unsupportedText =
  'This chat cannot currently accept the media file. Choose a compatible model and check attachment limits.';

const clients: QueryClient[] = [];
function mount({
  asset,
  files = new Map(),
  chat = true,
}: {
  asset: MediaAsset;
  files?: Map<string, ExtendedFile>;
  chat?: boolean;
}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, cacheTime: 0, staleTime: Infinity } },
    logger: { log: console.log, warn: console.warn, error: () => {} },
  });
  clients.push(client);
  client.setQueryData(startupConfigKey(false), makeStartupConfig({ chat }));
  client.setQueryData([QueryKeys.endpoints], { openAI: {} });
  client.setQueryData([QueryKeys.fileConfig], {
    endpoints: { openAI: { fileLimit: 1, fileSizeLimit: 0.001 } },
  });
  const store = createStore();
  store.set(mediaChatHandoff, {
    scope: mediaSessionScope(testUser),
    conversationId: 'chat',
    asset,
  });
  const setFiles = jest.fn();
  render(
    <QueryClientProvider client={client}>
      <RecoilRoot>
        <MemoryRouter>
          <Provider store={store}>
            <AuthContext.Provider value={makeAuthContext()}>
              <ChatMedia
                open={false}
                onOpenChange={() => {}}
                conversation={conversation}
                files={files}
                setFiles={setFiles}
                disabled={false}
                temporary={false}
              />
            </AuthContext.Provider>
          </Provider>
        </MemoryRouter>
      </RecoilRoot>
    </QueryClientProvider>,
  );
  return { store, setFiles };
}
beforeEach(() => clearMediaSessionStorage());
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
});

test('a handed-off image the destination accepts is attached and the handoff is consumed', async () => {
  const env = mount({ asset: { ...image, bytes: 500 } });
  await waitFor(() => expect(env.setFiles).toHaveBeenCalledTimes(1));
  const update = env.setFiles.mock.calls[0][0] as (
    previous: Map<string, ExtendedFile>,
  ) => Map<string, ExtendedFile>;
  expect(update(new Map()).get('generated')).toMatchObject({
    file_id: 'generated',
    size: 500,
    progress: 1,
    attached: true,
  });
  await waitFor(() => expect(env.store.get(mediaChatHandoff)).toBeNull());
  expect(screen.queryByText(unsupportedText)).not.toBeInTheDocument();
});

test.each([
  [
    'the file count limit is already met',
    { ...image, bytes: 500 },
    new Map([[attached.file_id, attached]]),
  ],
  ['the file exceeds the size limit', { ...image, bytes: 5000 }, new Map()],
  [
    'the type is not one the provider accepts',
    { ...image, filename: 'notes.txt', type: 'text/plain', bytes: 500 },
    new Map(),
  ],
])('rejects the handoff when %s and lets the reader dismiss it', async (_label, asset, files) => {
  const env = mount({ asset, files });
  expect(await screen.findByRole('alert')).toHaveTextContent(unsupportedText);
  expect(env.setFiles).not.toHaveBeenCalled();
  expect(env.store.get(mediaChatHandoff)).not.toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  expect(env.store.get(mediaChatHandoff)).toBeNull();
});

test('Studio handoff is consumed with the embedded creation surface switched off', async () => {
  const env = mount({ asset: { ...image, bytes: 500 }, chat: false });
  expect(screen.queryByRole('button', { name: 'Create media' })).not.toBeInTheDocument();
  await waitFor(() => expect(env.setFiles).toHaveBeenCalledTimes(1));
  expect(env.store.get(mediaChatHandoff)).toBeNull();
});
