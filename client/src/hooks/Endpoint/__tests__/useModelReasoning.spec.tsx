import { renderHook } from '@testing-library/react';
import type { TEndpointsConfig, TReasoningCapabilityMap } from 'librechat-data-provider';
import { useModelReasoning } from '../useModelReasoning';

let mockCapabilities: TReasoningCapabilityMap | undefined;
let mockLoading = false;
const mockQuery = jest.fn();
jest.mock('~/data-provider', () => ({
  useReasoningCapabilitiesQuery: (config: { enabled?: boolean }) => {
    mockQuery(config);
    const enabled = config?.enabled !== false;
    return {
      data: enabled ? mockCapabilities : undefined,
      isInitialLoading: enabled && mockLoading,
    };
  },
}));

const model = 'openai/gpt-6.1-sol';
const openRouter = {
  OpenRouter: {
    order: 0,
    type: 'custom',
    customParams: { defaultParamsEndpoint: 'openrouter' },
  },
} as TEndpointsConfig;

beforeEach(() => {
  mockCapabilities = undefined;
  mockLoading = false;
  mockQuery.mockClear();
});

describe('useModelReasoning', () => {
  it('is unknown until the capabilities have loaded', () => {
    const { result } = renderHook(() => useModelReasoning(openRouter, 'OpenRouter', model));

    expect(result.current.modelReasoning).toBeUndefined();
  });

  it('returns the efforts of the selected model once loaded', () => {
    mockCapabilities = { OpenRouter: { [model]: { efforts: ['low', 'high'] } } };

    const { result } = renderHook(() => useModelReasoning(openRouter, 'OpenRouter', model));

    expect(result.current.modelReasoning).toEqual({ efforts: ['low', 'high'] });
  });

  it('reports no reasoning for a model the loaded catalog does not list', () => {
    mockCapabilities = { OpenRouter: { 'meta/other': { efforts: ['low'] } } };

    const { result } = renderHook(() => useModelReasoning(openRouter, 'OpenRouter', model));

    expect(result.current.modelReasoning).toBeNull();
  });

  it('ignores the provider efforts when the administrator defined reasoning_effort', () => {
    mockCapabilities = { OpenRouter: { [model]: { efforts: ['low'] } } };
    const endpoints = {
      OpenRouter: {
        order: 0,
        type: 'custom',
        customParams: {
          defaultParamsEndpoint: 'openrouter',
          paramDefinitions: [{ key: 'reasoning_effort', options: ['low', 'max'] }],
        },
      },
    } as TEndpointsConfig;

    const { result } = renderHook(() => useModelReasoning(endpoints, 'OpenRouter', model));

    expect(result.current.modelReasoning).toBeUndefined();
  });

  it('reports pending while the first capabilities request is in flight', () => {
    mockLoading = true;

    const { result } = renderHook(() => useModelReasoning(openRouter, 'OpenRouter', model));

    expect(result.current.pending).toBe(true);
    expect(result.current.modelReasoning).toBeUndefined();
  });

  it('is not pending once the capabilities have loaded', () => {
    mockCapabilities = { OpenRouter: { [model]: { efforts: ['low'] } } };

    const { result } = renderHook(() => useModelReasoning(openRouter, 'OpenRouter', model));

    expect(result.current.pending).toBe(false);
  });

  it('is never pending for an endpoint that does not use capabilities', () => {
    mockLoading = true;
    const endpoints = { openAI: { order: 0, type: 'openAI' } } as TEndpointsConfig;

    const { result } = renderHook(() => useModelReasoning(endpoints, 'openAI', model));

    expect(result.current.pending).toBe(false);
  });

  it('does not request capabilities for an endpoint that is not OpenRouter', () => {
    const endpoints = {
      Local: { order: 0, type: 'custom', customParams: { defaultParamsEndpoint: 'custom' } },
    } as TEndpointsConfig;

    const { result } = renderHook(() => useModelReasoning(endpoints, 'Local', model));

    expect(mockQuery).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
    expect(result.current.modelReasoning).toBeUndefined();
  });

  it('does not request capabilities for a native endpoint', () => {
    const endpoints = { openAI: { order: 0, type: 'openAI' } } as TEndpointsConfig;

    renderHook(() => useModelReasoning(endpoints, 'openAI', model));

    expect(mockQuery).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  });

  it('requests capabilities for an OpenRouter endpoint', () => {
    renderHook(() => useModelReasoning(openRouter, 'OpenRouter', model));

    expect(mockQuery).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
  });
});
