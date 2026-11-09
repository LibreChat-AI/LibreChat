import { renderHook, act } from '@testing-library/react';
import { EModelEndpoint } from 'librechat-data-provider';
import type { TConversation } from 'librechat-data-provider';

const mockNewConversation = jest.fn();
const mockFetchQuery = jest.fn();
const mockGetConversation = jest.fn();
const mockGetDefaultConversation = jest.fn();

jest.mock('@tanstack/react-query', () => ({
  useQueryClient: jest.fn(() => ({ fetchQuery: mockFetchQuery })),
}));

jest.mock('~/hooks/useNewConvo', () => ({
  __esModule: true,
  default: jest.fn(() => ({ newConversation: mockNewConversation })),
}));

jest.mock('~/hooks/Conversations/useGetConversation', () => ({
  __esModule: true,
  default: jest.fn(() => mockGetConversation),
}));

jest.mock('~/hooks/Conversations/useDefaultConvo', () => ({
  __esModule: true,
  default: jest.fn(() => mockGetDefaultConversation),
}));

jest.mock('~/Providers/AgentsMapContext', () => ({
  useAgentsMapContext: jest.fn(() => ({ 'agent-1': { id: 'agent-1', name: 'Agent' } })),
}));

jest.mock('~/utils', () => ({
  logger: { log: jest.fn() },
  specDisplayFieldReset: {
    spec: null,
    iconURL: null,
    modelLabel: null,
    greeting: undefined,
  },
}));

import useSelectAgent from '../useSelectAgent';

describe('useSelectAgent', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetConversation.mockResolvedValue({ endpoint: EModelEndpoint.agents } as TConversation);
    mockGetDefaultConversation.mockImplementation(
      ({
        conversation,
        preset,
      }: {
        conversation: Partial<TConversation>;
        preset: Partial<TConversation>;
      }) => ({
        ...conversation,
        ...preset,
      }),
    );
  });

  it('opens one fresh composer without waiting for or reopening it for metadata', async () => {
    mockFetchQuery.mockResolvedValue({ id: 'agent-1', name: 'Full Agent' });
    const { result } = renderHook(() => useSelectAgent());

    await act(async () => {
      await result.current.onSelect('agent-1');
    });

    expect(mockNewConversation).toHaveBeenCalledTimes(1);
    expect(mockNewConversation.mock.calls[0][0].keepComposerState).toBeUndefined();
    expect(mockFetchQuery).not.toHaveBeenCalled();
  });

  it('does not couple selection to a metadata request', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockFetchQuery.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useSelectAgent());

    await act(async () => {
      await result.current.onSelect('agent-1');
    });

    expect(mockNewConversation).toHaveBeenCalledTimes(1);
    expect(mockFetchQuery).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('keeps the composer for the assistants path as well', async () => {
    mockGetConversation.mockResolvedValue({
      endpoint: EModelEndpoint.assistants,
    } as TConversation);
    mockFetchQuery.mockResolvedValue({ id: 'agent-1', name: 'Full Agent' });
    const { result } = renderHook(() => useSelectAgent());

    await act(async () => {
      await result.current.onSelect('agent-1');
    });

    expect(mockGetDefaultConversation).not.toHaveBeenCalled();
    expect(mockNewConversation.mock.calls[0][0].keepComposerState).toBeUndefined();
    expect(mockFetchQuery).not.toHaveBeenCalled();
  });

  it('clears model spec display fields when selecting an agent', async () => {
    mockGetConversation.mockResolvedValue({
      endpoint: EModelEndpoint.openAI,
      spec: 'ClickHouse Agent',
      iconURL: EModelEndpoint.bedrock,
      modelLabel: 'ClickHouse Agent',
    } as TConversation);
    mockFetchQuery.mockResolvedValue({ id: 'agent-1', name: 'Full Agent' });
    const { result } = renderHook(() => useSelectAgent());

    await act(async () => {
      await result.current.onSelect('agent-1');
    });

    const firstConversation = mockNewConversation.mock.calls[0][0].template;
    expect(firstConversation).toMatchObject({
      endpoint: EModelEndpoint.agents,
      agent_id: 'agent-1',
      spec: null,
      iconURL: null,
      modelLabel: null,
      codeWorkspaces: undefined,
    });
  });

  it('does not carry a prior agent workspace binding into the selected agent', async () => {
    mockGetConversation.mockResolvedValue({
      endpoint: EModelEndpoint.agents,
      agent_id: 'agent-old',
      codeWorkspaces: [{ environmentId: 'machine-a', workspaceId: 'project-old' }],
    } as TConversation);
    mockFetchQuery.mockResolvedValue({ id: 'agent-1', name: 'Full Agent' });
    const { result } = renderHook(() => useSelectAgent());

    await act(async () => {
      await result.current.onSelect('agent-1');
    });

    expect(mockNewConversation.mock.calls[0][0].template.codeWorkspaces).toBeUndefined();
    expect(mockFetchQuery).not.toHaveBeenCalled();
    expect(mockGetDefaultConversation.mock.calls[0][0].conversation.codeWorkspaces).toBeUndefined();
  });

  it('leaves subsequent workspace choices to the active conversation', async () => {
    const selectedWorkspace = [{ environmentId: 'machine-a', workspaceId: 'project-a' }];
    mockGetConversation
      .mockResolvedValueOnce({
        endpoint: EModelEndpoint.agents,
        agent_id: 'agent-old',
      } as TConversation)
      .mockResolvedValueOnce({
        endpoint: EModelEndpoint.agents,
        agent_id: 'agent-1',
        codeWorkspaces: selectedWorkspace,
      } as TConversation);
    mockFetchQuery.mockResolvedValue({ id: 'agent-1', name: 'Full Agent' });
    const { result } = renderHook(() => useSelectAgent());

    await act(async () => {
      await result.current.onSelect('agent-1');
    });

    expect(mockNewConversation.mock.calls[0][0].template.codeWorkspaces).toBeUndefined();
    expect(mockFetchQuery).not.toHaveBeenCalled();
  });
});
