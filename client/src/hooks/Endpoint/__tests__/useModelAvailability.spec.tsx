import React from 'react';
import { RecoilRoot } from 'recoil';
import { act, renderHook, waitFor } from '@testing-library/react';
import { EModelEndpoint, QueryKeys } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TConversation } from 'librechat-data-provider';
import useModelAvailability from '../useModelAvailability';
import store from '~/store';

const conversation: TConversation = {
  conversationId: 'new',
  endpoint: EModelEndpoint.openAI,
  model: 'saved',
  title: '',
  createdAt: '',
  updatedAt: '',
};

it('shows a missing-selection hint before discovery, while valid selections remain enabled', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { enabled: false, retry: false, cacheTime: 0 } },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>
      <RecoilRoot initializeState={({ set }) => set(store.queriesEnabled, false)}>
        {children}
      </RecoilRoot>
    </QueryClientProvider>
  );
  const { result, rerender, unmount } = renderHook<
    ReturnType<typeof useModelAvailability>,
    { selection: TConversation; added?: TConversation }
  >(
    ({ selection, added }: { selection: TConversation; added?: TConversation }) =>
      useModelAvailability(selection, added),
    {
      wrapper,
      initialProps: { selection: conversation },
    },
  );
  try {
    expect(result.current.showSelectionHint).toBe(false);
    act(() =>
      client.setQueryData([QueryKeys.endpoints], { openAI: { order: 0 }, agents: { order: 1 } }),
    );
    await waitFor(() => expect(result.current.canSubmit).toBe(true));
    expect(result.current.ready).toBe(false);
    rerender({ selection: { ...conversation, model: '' } });
    expect(result.current).toMatchObject({
      canSubmit: false,
      showSelectionHint: true,
      hasModels: true,
    });
    rerender({ selection: { ...conversation, endpoint: null } });
    expect(result.current.showSelectionHint).toBe(true);
    rerender({
      selection: {
        ...conversation,
        endpoint: EModelEndpoint.agents,
        agent_id: 'agent_saved',
        model: null,
      },
    });
    expect(result.current).toMatchObject({ canSubmit: true, showSelectionHint: false });
    rerender({ selection: conversation, added: { ...conversation, model: '' } });
    expect(result.current.showSelectionHint).toBe(true);
    rerender({ selection: conversation });
    act(() => client.setQueryData([QueryKeys.models], { openAI: [] }));
    await waitFor(() =>
      expect(result.current).toMatchObject({
        canSubmit: false,
        showSelectionHint: true,
        hasModels: false,
      }),
    );
    act(() => client.setQueryData([QueryKeys.models], { openAI: ['saved'] }));
    await waitFor(() =>
      expect(result.current).toMatchObject({ canSubmit: true, showSelectionHint: false }),
    );
  } finally {
    unmount();
    client.clear();
  }
});
