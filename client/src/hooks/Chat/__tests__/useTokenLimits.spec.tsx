import { renderHook } from '@testing-library/react';
import type { TEndpointsConfig, Agent, TConversation } from 'librechat-data-provider';
import useTokenLimits from '../useTokenLimits';

let mockAgent: Partial<Agent> | undefined;
let mockEndpoints: TEndpointsConfig;
const mockTokenQuery = jest.fn();
jest.mock('~/data-provider', () => ({
  useGetAgentByIdQuery: () => ({ data: mockAgent }),
  useGetEndpointsQuery: () => ({ data: mockEndpoints }),
  useTokenConfigQuery: (...args: unknown[]) => mockTokenQuery(...args),
}));
jest.mock('~/Providers/ChatSettingsContext', () => ({
  useChatSettings: () => ({ config: {} }),
}));

beforeEach(() => {
  mockAgent = undefined;
  mockEndpoints = { google: { order: 0 }, ollama: { order: 1 } };
  mockTokenQuery.mockImplementation((_options, endpoint) => ({
    data: { [endpoint]: { selected: { context: 4096 } } },
  }));
});
it.each([
  ['vertexai', 'google'],
  ['Ollama', 'ollama'],
])('requests %s under the served %s catalog', (provider, catalog) => {
  mockAgent = { id: 'agent_selected', provider, model: 'selected' };
  const { result } = renderHook(() =>
    useTokenLimits({ endpoint: 'agents', agent_id: 'agent_selected' } as TConversation),
  );
  expect(mockTokenQuery).toHaveBeenCalledWith({ enabled: true }, catalog);
  expect(result.current).toMatchObject({
    endpoint: catalog,
    model: 'selected',
    maxContextTokens: 4096,
  });
});
it('preserves an exact configured name ahead of a native alias', () => {
  mockAgent = { id: 'agent_selected', provider: 'vertexai', model: 'selected' };
  mockEndpoints = { vertexai: { order: 0, type: 'custom' } } as TEndpointsConfig;
  renderHook(() =>
    useTokenLimits({ endpoint: 'agents', agent_id: 'agent_selected' } as TConversation),
  );
  expect(mockTokenQuery).toHaveBeenCalledWith({ enabled: true }, 'vertexai');
});
