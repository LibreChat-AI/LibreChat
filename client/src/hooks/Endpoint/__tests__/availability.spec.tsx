import React from 'react';
import { RecoilRoot } from 'recoil';
import { BrowserRouter } from 'react-router-dom';
import { ChatContext } from '@librechat/chat/react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryKeys, EModelEndpoint } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TConversation, TStartupConfig } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import {
  ModelSelectorProvider,
  useModelSelectorContext,
} from '~/components/Chat/Menus/Endpoints/ModelSelectorContext';
import { ModelSelectorChatProvider } from '~/components/Chat/Menus/Endpoints/ModelSelectorChatContext';
import { startupConfigKey } from '~/data-provider/Endpoints/queries';
import useModelAvailability from '../useModelAvailability';
import { AuthContextProvider } from '~/hooks/AuthContext';
import useMentions from '~/hooks/Input/useMentions';
import store from '~/store';

const startupConfig = {
  interface: { modelSelect: false },
  modelSpecs: {
    list: [
      {
        name: 'personal',
        label: 'Personal model',
        preset: { endpoint: 'Personal', model: 'saved' },
      },
      {
        name: 'ordinary',
        label: 'Ordinary model',
        preset: { endpoint: 'Ordinary', model: 'saved' },
      },
    ],
  },
} as TStartupConfig;
const selection: TConversation = {
  conversationId: 'saved-chat',
  endpoint: 'Personal' as EModelEndpoint,
  endpointType: EModelEndpoint.custom,
  model: 'saved',
  title: 'Saved chat',
  createdAt: '',
  updatedAt: '',
};

it('keeps personal-key specs in selector and mentions while blocking sends until the model returns', async () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { enabled: false, retry: false, staleTime: Infinity, cacheTime: 0 },
    },
  });
  queryClient.setQueryData(startupConfigKey(false), startupConfig);
  queryClient.setQueryData(startupConfigKey(true), startupConfig);
  queryClient.setQueryData([QueryKeys.models], { Personal: [], Ordinary: [] });
  queryClient.setQueryData([QueryKeys.endpoints], {
    Personal: { order: 0 },
    Ordinary: { order: 1 },
  });
  const chatContext: Pick<
    NonNullable<React.ContextType<typeof ChatContext>>,
    'conversation' | 'setConversation'
  > = {
    conversation: null,
    setConversation: jest.fn(),
  };
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <RecoilRoot initializeState={({ set }) => set(store.queriesEnabled, false)}>
        <BrowserRouter>
          <AuthContextProvider authConfig={{ loginRedirect: '', test: true }}>
            <ChatContext.Provider value={chatContext as React.ContextType<typeof ChatContext>}>
              <ModelSelectorChatProvider>
                <ModelSelectorProvider startupConfig={startupConfig}>
                  {children}
                </ModelSelectorProvider>
              </ModelSelectorChatProvider>
            </ChatContext.Provider>
          </AuthContextProvider>
        </BrowserRouter>
      </RecoilRoot>
    </QueryClientProvider>
  );
  const { result, unmount } = renderHook(
    () => ({
      selector: useModelSelectorContext(),
      mentions: useMentions({ assistantMap: {}, includeAssistants: false }),
      availability: useModelAvailability(selection),
    }),
    { wrapper },
  );
  try {
    expect(result.current.selector.modelSpecs).toEqual([]);
    expect(result.current.mentions.options).toEqual([]);
    expect(result.current.availability.canSubmit).toBe(false);
    act(() => {
      queryClient.setQueryData([QueryKeys.endpoints], {
        Personal: { order: 0, userProvide: true },
        Ordinary: { order: 1, userProvide: false },
      });
    });
    await waitFor(() => {
      expect(result.current.selector.modelSpecs.map((spec) => spec.name)).toEqual(['personal']);
      expect(result.current.mentions.options.map((option) => option.value)).toEqual(['personal']);
    });
    expect(result.current.selector.mappedEndpoints).toEqual([]);
    expect(result.current.availability.canSubmit).toBe(false);
    act(() => {
      queryClient.setQueryData([QueryKeys.models], { Personal: ['other'], Ordinary: [] });
    });
    await waitFor(() => expect(result.current.availability.hasModels).toBe(true));
    expect(result.current.availability.canSubmit).toBe(false);
    act(() => {
      queryClient.setQueryData([QueryKeys.models], { Personal: ['saved'], Ordinary: [] });
    });
    await waitFor(() => expect(result.current.availability.canSubmit).toBe(true));
    expect(selection.model).toBe('saved');
  } finally {
    unmount();
    queryClient.clear();
  }
});
