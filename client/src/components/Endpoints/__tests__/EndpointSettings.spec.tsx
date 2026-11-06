import React from 'react';
import { RecoilRoot } from 'recoil';
import { act, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EModelEndpoint, QueryKeys, SettingsViews } from 'librechat-data-provider';
import type { TConversation } from 'librechat-data-provider';
import Settings from '../EndpointSettings';
import store from '~/store';

jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('../Settings', () => ({
  getSettings: () => ({
    settings: { custom: ({ models }: { models: string[] }) => <div>{models.join(',')}</div> },
    multiViewSettings: {},
  }),
}));

it('resolves aliases and retains the unavailable notice after a failed refresh', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { enabled: false, retry: false, cacheTime: 0 } },
    logger: { log: console.log, warn: console.warn, error: jest.fn() },
  });
  client.setQueryData([QueryKeys.endpoints], {
    vertexai: { order: 0, type: EModelEndpoint.custom },
  });
  const conversation: TConversation = {
    endpoint: 'vertexai' as EModelEndpoint,
    model: 'saved',
    conversationId: 'saved-chat',
    title: '',
    createdAt: '',
    updatedAt: '',
  };
  const { unmount } = render(
    <QueryClientProvider client={client}>
      <RecoilRoot
        initializeState={({ set }) => {
          set(store.queriesEnabled, false);
          set(store.currentSettingsView, SettingsViews.default);
        }}
      >
        <Settings conversation={conversation} setOption={jest.fn()} />
      </RecoilRoot>
    </QueryClientProvider>,
  );
  try {
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    act(() => client.setQueryData([QueryKeys.models], { google: ['saved'] }));
    await screen.findByText('saved');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    act(() => client.setQueryData([QueryKeys.models], { google: [] }));
    await screen.findByText('com_ui_model_unavailable');
    await act(async () => {
      await expect(
        client.fetchQuery({
          queryKey: [QueryKeys.models],
          staleTime: 0,
          queryFn: async () => {
            throw new Error('offline');
          },
        }),
      ).rejects.toThrow('offline');
    });
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('com_ui_model_unavailable'),
    );
  } finally {
    unmount();
    client.clear();
  }
});
