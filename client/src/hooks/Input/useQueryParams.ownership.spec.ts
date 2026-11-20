import React from 'react';
import { useRecoilValue } from 'recoil';
import { act, renderHook } from '@testing-library/react';
import { EModelEndpoint } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  registerComposerDraft,
  captureComposerDraft,
  bindComposerLaunch,
  adoptComposerConversation,
} from '~/utils/drafts';
import {
  beginFileSearchUpload,
  captureFileSearchUpload,
  completeFileSearchUpload,
} from '~/hooks/Files/search';
import useQueryParams from './useQueryParams';

const mockSubmit = jest.fn();
const mockNewConversation = jest.fn();
const mockContext = {
  index: 2,
  conversation: { conversationId: 'new', endpoint: EModelEndpoint.openAI },
  newConversation: mockNewConversation,
};
let mockText = '';
const mockMethods = {
  setValue: (_name: string, text: string) => {
    mockText = text;
  },
  getValues: () => mockText,
  handleSubmit: (accepted: (data: { text: string }) => void) => () => accepted({ text: mockText }),
};

jest.mock('react-router-dom', () => ({
  useLocation: () => ({
    pathname: globalThis.window.location.pathname,
    search: globalThis.window.location.search,
  }),
  useSearchParams: () => [
    new URLSearchParams(globalThis.window.location.search),
    (params: URLSearchParams) => {
      const query = params.toString();
      globalThis.window.history.replaceState(
        {},
        '',
        globalThis.window.location.pathname + (query ? `?${query}` : ''),
      );
    },
  ],
}));
jest.mock('recoil', () => ({
  ...jest.requireActual('recoil'),
  useRecoilValue: jest.fn(),
}));
jest.mock('~/hooks', () => ({
  useAuthContext: () => ({ isAuthenticated: true }),
  useAgentsMap: () => ({}),
  useDefaultConvo: () => () => ({}),
  useSubmitMessage: () => ({ submitMessage: mockSubmit }),
}));
jest.mock('~/Providers', () => ({
  useChatContext: () => mockContext,
  useChatFormContext: () => mockMethods,
}));
jest.mock('~/data-provider', () => ({
  startupConfigKey: () => ['startupConfig'],
  useGetAgentByIdQuery: () => ({ data: null }),
}));
jest.mock('~/hooks/Chat/ask/guards', () => ({ isHistoryRevalidating: () => false }));
jest.mock('~/store', () => ({
  __esModule: true,
  default: { modularChat: 'modularChat', availableTools: 'availableTools' },
}));
jest.mock('~/utils', () => ({
  ...jest.requireActual('~/utils/drafts'),
  processValidSettings: (settings: Record<string, string>) => settings,
  logger: { log: jest.fn() },
}));

describe('consumed prompt URL ownership', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    localStorage.clear();
    mockSubmit.mockReset();
    mockNewConversation.mockReset();
    mockText = '';
    (useRecoilValue as jest.Mock).mockImplementation((key) =>
      key === 'availableTools' ? [] : false,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
    window.history.replaceState({}, '', '/');
  });

  it.each([false, true])(
    'preserves the real query cleanup before first-ID acknowledgement (auto-submit: %s)',
    (autoSubmit) => {
      window.history.replaceState(
        {},
        '',
        `/c/new?prompt=hello&projectId=project-1${autoSubmit ? '&submit=true' : ''}`,
      );
      const release = registerComposerDraft(2, 'new', 'new:2', {});
      const captured = captureComposerDraft(2, 'new');
      const launch = { conversationId: 'new' };
      mockSubmit.mockImplementation(() => bindComposerLaunch(launch, 2));
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false, cacheTime: Infinity } },
      });
      client.setQueryData(['startupConfig'], { modelSpecs: { list: [] } });
      const wrapper = ({ children }: { children: React.ReactNode }) =>
        React.createElement(QueryClientProvider, { client }, children);
      const textAreaRef = { current: document.createElement('textarea') };
      const { unmount } = renderHook(() => useQueryParams({ textAreaRef }), { wrapper });
      act(() => jest.advanceTimersByTime(100));
      expect(mockText).toBe('hello');
      expect(window.location.search).toBe('?projectId=project-1');
      expect(captured()).toBe(true);
      expect(mockSubmit).toHaveBeenCalledTimes(autoSubmit ? 1 : 0);
      if (!autoSubmit) bindComposerLaunch(launch, 2);
      beginFileSearchUpload('url-search', captureFileSearchUpload('new', captured));
      expect(adoptComposerConversation(launch, 'saved-query', 2)).toBe(true);
      expect(captured.conversationId()).toBe('saved-query');
      expect(completeFileSearchUpload('url-search', 'saved-query')).toBe(true);
      window.history.replaceState({}, '', '/c/unrelated');
      expect(captured()).toBe(false);
      release();
      unmount();
      client.clear();
    },
  );
});
