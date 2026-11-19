import { RecoilRoot } from 'recoil';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { QueryKeys, EModelEndpoint, getResponseSender } from 'librechat-data-provider';
import type { TStartupConfig, TEndpointsConfig, TConversation } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import { startupConfigKey } from '~/data-provider';
import { useSelectedSender } from '../shown';

const endpointsConfig = {
  'Mock Provider': { type: EModelEndpoint.custom },
} as unknown as TEndpointsConfig;

const modelSpecs = {
  list: [
    { name: 'first-spec', label: 'First Spec' },
    { name: 'second-spec', label: 'Second Spec' },
  ],
};

const startup = (overrides: Record<string, unknown>) =>
  ({ modelSpecs, ...overrides }) as unknown as TStartupConfig;

const hidesAuthors = startup({ interface: { messageAuthor: 'whenDifferent' } });

const conversationOn = (spec?: string) =>
  ({
    conversationId: 'convo-1',
    endpoint: 'Mock Provider' as EModelEndpoint,
    endpointType: EModelEndpoint.custom,
    model: 'mock-model',
    spec,
  }) as TConversation;

function renderSelectedSender(config: TStartupConfig, conversation: TConversation | null) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, enabled: false } },
  });
  queryClient.setQueryData([QueryKeys.endpoints], endpointsConfig);
  queryClient.setQueryData(startupConfigKey(false), config);
  const { result } = renderHook(() => useSelectedSender(conversation), {
    wrapper: function Wrapper({ children }: { children: ReactNode }) {
      return (
        <RecoilRoot>
          <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        </RecoilRoot>
      );
    },
  });
  return result.current;
}

describe('useSelectedSender', () => {
  it('names the label of the spec the conversation is on', () => {
    expect(renderSelectedSender(hidesAuthors, conversationOn('first-spec'))).toBe('First Spec');
  });

  it('tells two specs on the same model apart', () => {
    const first = renderSelectedSender(hidesAuthors, conversationOn('first-spec'));
    const second = renderSelectedSender(hidesAuthors, conversationOn('second-spec'));
    expect(second).toBe('Second Spec');
    expect(second).not.toBe(first);
  });

  it('names the model-derived sender when no spec is selected', () => {
    const plain = conversationOn();
    expect(renderSelectedSender(hidesAuthors, plain)).toBe(getResponseSender(plain));
  });

  it('names a custom endpoint from the type the endpoints config gives, not the one the conversation carries', () => {
    const untyped = { ...conversationOn(), endpointType: undefined } as TConversation;
    const sender = renderSelectedSender(hidesAuthors, untyped);
    expect(sender).not.toBe('');
    expect(sender).toBe(getResponseSender(conversationOn()));
  });

  it('leaves out the deprecated chatGptLabel, which the server never reads', () => {
    const legacy = { ...conversationOn(), chatGptLabel: 'Legacy Name' } as TConversation;
    expect(renderSelectedSender(hidesAuthors, legacy)).toBe(getResponseSender(conversationOn()));
  });

  it('keeps the custom name the server reads', () => {
    const named = { ...conversationOn(), modelLabel: 'Renamed' } as TConversation;
    expect(renderSelectedSender(hidesAuthors, named)).toBe('Renamed');
  });

  it.each([
    ['authors always show', startup({ interface: { messageAuthor: 'always' } })],
    ['the setting is absent', startup({ interface: {} })],
    [
      'no selector is shown',
      startup({
        interface: { messageAuthor: 'whenDifferent', modelSelect: false },
        modelSpecs: { list: [] },
      }),
    ],
  ])('names no sender when %s', (_case, config) => {
    expect(renderSelectedSender(config, conversationOn('first-spec'))).toBeUndefined();
  });

  it('names no sender without a conversation', () => {
    expect(renderSelectedSender(hidesAuthors, null)).toBeUndefined();
  });
});
