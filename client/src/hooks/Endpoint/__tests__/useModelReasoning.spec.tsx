import { renderHook } from '@testing-library/react';
import type { TEndpointsConfig, TReasoningCapabilityMap } from 'librechat-data-provider';
import { useModelReasoning } from '../useModelReasoning';

/** `undefined` is a query that is loading or failed: both leave the hook without data. */
let mockCapabilities: TReasoningCapabilityMap | undefined;
const mockQuery = jest.fn();
jest.mock('~/data-provider', () => ({
  useReasoningCapabilitiesQuery: (endpoint: string, config: { enabled?: boolean }) => {
    mockQuery(endpoint, config);
    const enabled = config?.enabled !== false;
    return { data: enabled ? mockCapabilities : undefined };
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
const withDefinition = {
  OpenRouter: {
    order: 0,
    type: 'custom',
    customParams: {
      defaultParamsEndpoint: 'openrouter',
      paramDefinitions: [{ key: 'reasoning_effort', options: ['low', 'max'] }],
    },
  },
} as TEndpointsConfig;

beforeEach(() => {
  mockCapabilities = undefined;
  mockQuery.mockClear();
});

describe('useModelReasoning', () => {
  it('hides the efforts until the capabilities have loaded', () => {
    const { result } = renderHook(() => useModelReasoning(openRouter, 'OpenRouter', model));

    expect(result.current.modelReasoning).toBeNull();
  });

  it('hides the efforts when the request failed, as the capabilities are then unknown', () => {
    mockCapabilities = undefined;

    const { result } = renderHook(() => useModelReasoning(openRouter, 'OpenRouter', model));

    expect(result.current.modelReasoning).toBeNull();
  });

  it('reports pending while the capabilities are unknown, whether loading or failed', () => {
    const { result } = renderHook(() => useModelReasoning(openRouter, 'OpenRouter', model));

    expect(result.current.pending).toBe(true);
  });

  it('returns the efforts of the selected model once loaded', () => {
    mockCapabilities = { OpenRouter: { [model]: { efforts: ['low', 'high'] } } };

    const { result } = renderHook(() => useModelReasoning(openRouter, 'OpenRouter', model));

    expect(result.current.modelReasoning).toEqual({ efforts: ['low', 'high'] });
    expect(result.current.pending).toBe(false);
  });

  it('reports no reasoning for a model the loaded catalog lists without it', () => {
    mockCapabilities = { OpenRouter: { [model]: { efforts: [] } } };

    const { result } = renderHook(() => useModelReasoning(openRouter, 'OpenRouter', model));

    expect(result.current.modelReasoning).toBeNull();
  });

  it('keeps the generic efforts for a model the loaded catalog does not list', () => {
    mockCapabilities = { OpenRouter: { 'meta/other': { efforts: ['low'] } } };

    const { result } = renderHook(() =>
      useModelReasoning(openRouter, 'OpenRouter', '~openai/gpt-latest'),
    );

    expect(result.current.modelReasoning).toBeUndefined();
    expect(result.current.pending).toBe(false);
  });

  it('keeps the generic efforts for an endpoint the server did not resolve', () => {
    mockCapabilities = {};

    const { result } = renderHook(() => useModelReasoning(openRouter, 'OpenRouter', model));

    expect(result.current.modelReasoning).toBeUndefined();
  });

  it('ignores the provider efforts when the administrator defined reasoning_effort', () => {
    mockCapabilities = { OpenRouter: { [model]: { efforts: ['low'] } } };

    const { result } = renderHook(() => useModelReasoning(withDefinition, 'OpenRouter', model));

    expect(result.current.modelReasoning).toBeUndefined();
  });

  it('keeps an administrator-defined reasoning_effort available while capabilities are unknown', () => {
    const { result } = renderHook(() => useModelReasoning(withDefinition, 'OpenRouter', model));

    expect(result.current.modelReasoning).toBeUndefined();
    expect(result.current.pending).toBe(false);
  });

  it('does not request capabilities when the administrator defined reasoning_effort', () => {
    renderHook(() => useModelReasoning(withDefinition, 'OpenRouter', model));

    expect(mockQuery).toHaveBeenCalledWith(
      'OpenRouter',
      expect.objectContaining({ enabled: false }),
    );
  });

  it('is never hidden or pending for an endpoint that does not use capabilities', () => {
    const endpoints = { openAI: { order: 0, type: 'openAI' } } as TEndpointsConfig;

    const { result } = renderHook(() => useModelReasoning(endpoints, 'openAI', model));

    expect(result.current.modelReasoning).toBeUndefined();
    expect(result.current.pending).toBe(false);
  });

  it('does not request capabilities for an endpoint that is not OpenRouter', () => {
    const endpoints = {
      Local: { order: 0, type: 'custom', customParams: { defaultParamsEndpoint: 'custom' } },
    } as TEndpointsConfig;

    renderHook(() => useModelReasoning(endpoints, 'Local', model));

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
