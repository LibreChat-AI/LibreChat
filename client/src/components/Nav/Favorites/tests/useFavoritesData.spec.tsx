import React from 'react';
import { render, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import useFavoritesData from '../useFavoritesData';

const mockGetAgentById = jest.fn();
const mockReorderFavorites = jest.fn();

let mockFavorites: Array<Record<string, string>> = [];
let mockAgentsMap: Record<string, unknown> | undefined = {};
let mockEndpointsConfig: Record<string, unknown> = { agents: {} };
let mockStartupConfigData: { modelSpecs: { list: Array<Record<string, unknown>> } } | undefined = {
  modelSpecs: { list: [] },
};

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: { getAgentById: (...args: unknown[]) => mockGetAgentById(...args) },
  };
});

jest.mock('~/data-provider', () => ({
  useGetEndpointsQuery: () => ({ data: mockEndpointsConfig, isLoading: false }),
  useGetStartupConfig: () => ({ data: mockStartupConfigData }),
}));

jest.mock('~/Providers', () => ({
  useAssistantsMapContext: () => ({}),
  useAgentsMapContext: () => mockAgentsMap,
}));

jest.mock('~/hooks/Input/useSelectMention', () => ({
  __esModule: true,
  default: () => ({ onSelectEndpoint: jest.fn(), onSelectSpec: jest.fn() }),
}));

jest.mock('~/hooks', () => ({
  useFavorites: () => ({
    favorites: mockFavorites,
    reorderFavorites: mockReorderFavorites,
    isLoading: false,
  }),
  useGetConversation: () => jest.fn(() => null),
  useNewConvo: () => ({ newConversation: jest.fn() }),
}));

let latest: ReturnType<typeof useFavoritesData> | undefined;

const Probe = () => {
  latest = useFavoritesData();
  return null;
};

const createClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

const renderProbe = () =>
  render(
    <QueryClientProvider client={createClient()}>
      <Probe />
    </QueryClientProvider>,
  );

describe('useFavoritesData', () => {
  beforeEach(() => {
    mockGetAgentById.mockReset();
    mockReorderFavorites.mockReset();
    mockFavorites = [];
    mockAgentsMap = {};
    mockEndpointsConfig = { agents: {} };
    mockStartupConfigData = { modelSpecs: { list: [] } };
  });

  it('removes favorites whose agent is gone (404/403) once the agents map has loaded', async () => {
    mockFavorites = [{ agentId: 'agent-gone' }, { model: 'gpt-4o', endpoint: 'openAI' }];
    mockGetAgentById.mockRejectedValue({ response: { status: 403 } });
    renderProbe();
    await waitFor(() => {
      expect(mockReorderFavorites).toHaveBeenCalledWith(
        [{ model: 'gpt-4o', endpoint: 'openAI' }],
        true,
      );
    });
    expect(mockReorderFavorites).toHaveBeenCalledTimes(1);
  });

  it('keeps favorites while the global agents map is still loading', async () => {
    mockFavorites = [{ agentId: 'agent-gone' }];
    mockAgentsMap = undefined;
    mockGetAgentById.mockRejectedValue({ response: { status: 403 } });
    renderProbe();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mockReorderFavorites).not.toHaveBeenCalled();
  });

  it('removes favorites whose spec is no longer in the startup config', async () => {
    mockFavorites = [{ spec: 'gone-spec' }, { model: 'gpt-4o', endpoint: 'openAI' }];
    renderProbe();
    await waitFor(() => {
      expect(mockReorderFavorites).toHaveBeenCalledWith(
        [{ model: 'gpt-4o', endpoint: 'openAI' }],
        true,
      );
    });
  });

  it('merges fetched agents into the resolved agents map', async () => {
    mockFavorites = [{ agentId: 'agent-live' }];
    mockGetAgentById.mockResolvedValue({ id: 'agent-live', name: 'Live Agent' });
    const { rerender } = renderProbe();
    await waitFor(() => {
      expect(latest?.agentsMap['agent-live']).toEqual(
        expect.objectContaining({ id: 'agent-live' }),
      );
    });
    rerender(
      <QueryClientProvider client={createClient()}>
        <Probe />
      </QueryClientProvider>,
    );
  });

  it('exposes specs from the startup config', () => {
    mockFavorites = [];
    mockStartupConfigData = {
      modelSpecs: { list: [{ name: 'fast', label: 'Fast', preset: {} }] },
    };
    renderProbe();
    expect(latest?.specsMap['fast']).toEqual(expect.objectContaining({ label: 'Fast' }));
  });

  it('skips agent fetching when the agents endpoint is disabled', async () => {
    mockFavorites = [{ agentId: 'agent-live' }];
    mockEndpointsConfig = {};
    renderProbe();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mockGetAgentById).not.toHaveBeenCalled();
  });
});
