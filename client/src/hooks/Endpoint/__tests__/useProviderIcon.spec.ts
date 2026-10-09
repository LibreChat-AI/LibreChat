import { renderHook } from '@testing-library/react';
import { EModelEndpoint, ProviderId } from 'librechat-data-provider';
import type { TEndpointsConfig } from 'librechat-data-provider';
import { useProviderIcon } from '../useProviderIcon';

const config: TEndpointsConfig = {
  'My OpenRouter': { type: EModelEndpoint.custom, providerId: ProviderId.openrouter, order: 0 },
  Branded: { type: EModelEndpoint.custom, iconURL: 'https://cdn.example.com/x.png', order: 1 },
  Declared: { type: EModelEndpoint.custom, iconURL: 'mistral', order: 2 },
  Ollama: { type: EModelEndpoint.custom, order: 3 },
};

const run = (endpoint: string, iconURL?: string) =>
  renderHook(() => useProviderIcon({ endpoint, endpointsConfig: config, iconURL })).result.current;

describe('useProviderIcon', () => {
  it('rule 1: an image iconURL wins and suppresses provider art', () => {
    expect(run('Branded')).toEqual({
      provider: null,
      imageURL: 'https://cdn.example.com/x.png',
    });
  });

  it('treats a relative asset path as an image', () => {
    expect(run('Custom', 'assets/company.png')).toEqual({
      provider: null,
      imageURL: 'assets/company.png',
    });
  });

  it('rule 2: an iconURL naming a provider resolves to that provider', () => {
    expect(run('Declared')).toEqual({ provider: ProviderId.mistral, imageURL: null });
  });

  it('rule 3: the server resolved providerId is used when no iconURL applies', () => {
    expect(run('My OpenRouter')).toEqual({ provider: ProviderId.openrouter, imageURL: null });
  });

  it('rule 4: a first-class endpoint maps through endpointToProvider', () => {
    expect(run(EModelEndpoint.anthropic)).toEqual({
      provider: ProviderId.anthropic,
      imageURL: null,
    });
  });

  it('rule 5: an unconfigured endpoint still matches on its name', () => {
    expect(run('Ollama')).toEqual({ provider: ProviderId.ollama, imageURL: null });
  });

  it('rule 6: nothing resolves to no provider and no image', () => {
    expect(run('Totally Unknown')).toEqual({ provider: null, imageURL: null });
  });

  it('entity endpoints resolve to no provider, so avatars win', () => {
    expect(run(EModelEndpoint.agents)).toEqual({ provider: null, imageURL: null });
  });
});
