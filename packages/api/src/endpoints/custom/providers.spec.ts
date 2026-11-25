import { ProviderId } from 'librechat-data-provider';
import { providerHosts, resolveEndpointProviderId } from './providers';

describe('resolveEndpointProviderId', () => {
  it('prefers an iconURL that names a provider', () => {
    expect(
      resolveEndpointProviderId({
        name: 'Internal Gateway',
        baseURL: 'https://gateway.internal/v1',
        iconURL: 'openrouter',
      }),
    ).toBe(ProviderId.openrouter);
  });

  it('ignores an iconURL that is an image address', () => {
    expect(
      resolveEndpointProviderId({
        name: 'OpenRouter',
        baseURL: 'https://openrouter.ai/api/v1',
        iconURL: 'https://example.com/logo.png',
      }),
    ).toBe(ProviderId.openrouter);
  });

  it('resolves a renamed endpoint from its baseURL host', () => {
    expect(
      resolveEndpointProviderId({
        name: 'My OpenRouter',
        baseURL: 'https://openrouter.ai/api/v1',
      }),
    ).toBe(ProviderId.openrouter);
  });

  it('matches a host on a subdomain', () => {
    expect(
      resolveEndpointProviderId({
        name: 'Groq Proxy',
        baseURL: 'https://eu.api.groq.com/openai/v1',
      }),
    ).toBe(ProviderId.groq);
  });

  it('resolves the Helicone gateway host documented in librechat.example.yaml', () => {
    expect(
      resolveEndpointProviderId({
        name: 'Team Gateway',
        baseURL: 'https://ai-gateway.helicone.ai',
      }),
    ).toBe(ProviderId.helicone);
  });

  it('recognizes the supported Cohere API host', () => {
    expect(
      resolveEndpointProviderId({
        name: 'My Cohere',
        baseURL: 'https://api.cohere.ai/v1',
      }),
    ).toBe(ProviderId.cohere);
  });

  it('honors an explicit native provider when the host is unknown', () => {
    expect(
      resolveEndpointProviderId({
        name: 'My Claude Proxy',
        baseURL: 'https://gateway.internal/v1',
        provider: 'anthropic',
      }),
    ).toBe(ProviderId.anthropic);
  });

  it('falls back to the endpoint name', () => {
    expect(resolveEndpointProviderId({ name: 'Mistral' })).toBe(ProviderId.mistral);
  });

  it('brands a renamed local Lemonade endpoint without branding other localhost services', () => {
    const baseURL = 'http://localhost:13305/v1';
    expect(resolveEndpointProviderId({ name: 'Local GPU', baseURL, iconURL: 'lemonade' })).toBe(
      ProviderId.lemonade,
    );
    expect(resolveEndpointProviderId({ name: 'AMD Lemonade', baseURL })).toBe(ProviderId.lemonade);
    expect(resolveEndpointProviderId({ name: 'Local GPU', baseURL })).toBeUndefined();
  });

  it('returns undefined for a self-hosted gateway with no signal', () => {
    expect(
      resolveEndpointProviderId({
        name: 'LiteLLM',
        baseURL: 'http://localhost:4000/v1',
      }),
    ).toBeUndefined();
  });

  it('survives a malformed baseURL', () => {
    expect(resolveEndpointProviderId({ name: 'Cohere', baseURL: 'not a url' })).toBe(
      ProviderId.cohere,
    );
  });
  it.each([
    ['https://team.openai.azure.com/openai/v1', ProviderId.azure],
    ['https://team.cognitiveservices.azure.com/openai/v1', ProviderId.azure],
    ['https://generativelanguage.googleapis.com/v1beta', ProviderId.google],
    ['https://aiplatform.googleapis.com/v1', ProviderId.google],
  ])('brands %s from its host alone', (baseURL, expected) => {
    expect(resolveEndpointProviderId({ name: 'Team Gateway', baseURL })).toBe(expected);
  });

  it('carries a host for every provider that one can identify', () => {
    /** Host-unresolvable by nature: bedrock is region-scoped under a shared AWS suffix,
     *  and Lemonade, MLX and Ollama run on operator-defined hosts. Anything else added
     *  to ProviderId without a host silently falls through to the generic mark. */
    const hostUnresolvable: ProviderId[] = [
      ProviderId.bedrock,
      ProviderId.lemonade,
      ProviderId.mlx,
      ProviderId.ollama,
    ];
    const covered = new Set(providerHosts.map(([, provider]) => provider));

    const missing = Object.values(ProviderId).filter(
      (provider) => !covered.has(provider) && !hostUnresolvable.includes(provider),
    );

    expect(missing).toEqual([]);
  });
});
