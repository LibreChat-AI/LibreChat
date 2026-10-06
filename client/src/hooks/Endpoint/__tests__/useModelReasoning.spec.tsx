import { renderHook } from '@testing-library/react';
import type { TEndpointsConfig, TReasoningCapabilityMap } from 'librechat-data-provider';
import { useModelReasoning } from '../useModelReasoning';

let mockCapabilities: TReasoningCapabilityMap | undefined;
let mockLoading = false;
const mockQuery = jest.fn();
jest.mock('~/data-provider', () => ({
  useReasoningCapabilitiesQuery: (endpoint: string, config: { enabled?: boolean }) => {
    mockQuery(endpoint, config);
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

  it('hides the efforts while the first capabilities request is in flight', () => {
    mockLoading = true;

    const { result } = renderHook(() => useModelReasoning(openRouter, 'OpenRouter', model));

    expect(result.current.modelReasoning).toBeNull();
  });

  it('keeps an administrator-defined reasoning_effort available while loading', () => {
    mockLoading = true;
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

  it('shows the efforts once loaded', () => {
    mockCapabilities = { OpenRouter: { [model]: { efforts: ['low'] } } };

    const { result } = renderHook(() => useModelReasoning(openRouter, 'OpenRouter', model));

    expect(result.current.modelReasoning).toEqual({ efforts: ['low'] });
  });

  it('falls back to the generic efforts when the request failed', () => {
    mockCapabilities = undefined;
    mockLoading = false;

    const { result } = renderHook(() => useModelReasoning(openRouter, 'OpenRouter', model));

    expect(result.current.modelReasoning).toBeUndefined();
  });

  it('is never hidden for an endpoint that does not use capabilities', () => {
    mockLoading = true;
    const endpoints = { openAI: { order: 0, type: 'openAI' } } as TEndpointsConfig;

    const { result } = renderHook(() => useModelReasoning(endpoints, 'openAI', model));

    expect(result.current.modelReasoning).toBeUndefined();
  });

  it('does not request capabilities for an endpoint that is not OpenRouter', () => {
    const endpoints = {
      Local: { order: 0, type: 'custom', customParams: { defaultParamsEndpoint: 'custom' } },
    } as TEndpointsConfig;

    const { result } = renderHook(() => useModelReasoning(endpoints, 'Local', model));

    expect(mockQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ enabled: false }),
    );
    expect(result.current.modelReasoning).toBeUndefined();
  });

  it('does not request capabilities for a native endpoint', () => {
    const endpoints = { openAI: { order: 0, type: 'openAI' } } as TEndpointsConfig;

    renderHook(() => useModelReasoning(endpoints, 'openAI', model));

    expect(mockQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ enabled: false }),
    );
  });

  it('requests capabilities for an OpenRouter endpoint', () => {
    renderHook(() => useModelReasoning(openRouter, 'OpenRouter', model));

    expect(mockQuery).toHaveBeenCalledWith(
      'OpenRouter',
      expect.objectContaining({ enabled: true }),
    );
  });
});
