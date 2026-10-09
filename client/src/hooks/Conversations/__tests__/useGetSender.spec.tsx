import { RecoilRoot } from 'recoil';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { QueryKeys, EModelEndpoint, getResponseSender } from 'librechat-data-provider';
import type { TStartupConfig, TEndpointsConfig, TEndpointOption } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import { startupConfigKey } from '~/data-provider';
import useGetSender from '../useGetSender';

const startupConfig = {
  modelSpecs: {
    list: [{ name: 'fast-qwen', label: 'Fast Qwen' }],
  },
} as unknown as TStartupConfig;

const endpointsConfig = {
  'Together AI': { modelDisplayLabel: 'Together' },
  openAI: {},
} as unknown as TEndpointsConfig;

const renderGetSender = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, enabled: false } },
  });
  queryClient.setQueryData([QueryKeys.endpoints], endpointsConfig);
  queryClient.setQueryData(startupConfigKey(false), startupConfig);
  const { result } = renderHook(() => useGetSender(), {
    wrapper: function Wrapper({ children }: { children: ReactNode }) {
      return (
        <RecoilRoot>
          <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        </RecoilRoot>
      );
    },
  });
  return result.current;
};

const asOption = (option: Record<string, unknown>) => option as TEndpointOption;

describe('useGetSender', () => {
  it('prefers modelLabel over the spec and endpoint labels', () => {
    const getSender = renderGetSender();
    expect(
      getSender(
        asOption({
          endpoint: 'Together AI',
          endpointType: EModelEndpoint.custom,
          model: 'Qwen/Qwen2.5-72B-Instruct',
          modelLabel: 'My Qwen',
          spec: 'fast-qwen',
        }),
      ),
    ).toBe('My Qwen');
  });

  it('surfaces the model spec label when no modelLabel is set', () => {
    const getSender = renderGetSender();
    expect(
      getSender(
        asOption({
          endpoint: 'Together AI',
          endpointType: EModelEndpoint.custom,
          model: 'Qwen/Qwen2.5-72B-Instruct',
          spec: 'fast-qwen',
        }),
      ),
    ).toBe('Fast Qwen');
  });

  it('lets the explicit modelDisplayLabel beat the family heuristic', () => {
    const getSender = renderGetSender();
    expect(
      getSender(
        asOption({
          endpoint: 'Together AI',
          endpointType: EModelEndpoint.custom,
          model: 'mistralai/Mixtral-8x7B-Instruct-v0.1',
        }),
      ),
    ).toBe('Together');
  });

  it('falls through to getResponseSender when no label resolves', () => {
    const getSender = renderGetSender();
    expect(getSender(asOption({ endpoint: EModelEndpoint.anthropic }))).toBe('Claude');
    const unknownCustom = {
      endpoint: 'LocalAI',
      endpointType: EModelEndpoint.custom,
      model: 'some-unknown-model',
    };
    expect(getSender(asOption(unknownCustom))).toBe(getResponseSender(asOption(unknownCustom)));
  });

  it('never reveals model or spec labels for agent conversations', () => {
    const getSender = renderGetSender();
    expect(
      getSender(
        asOption({
          endpoint: EModelEndpoint.agents,
          agent_id: 'agent_abc123',
          model: 'gpt-5.5',
          modelLabel: 'GPT-5.5 Pro',
          spec: 'fast-qwen',
        }),
      ),
    ).toBe('');
  });
});
