import {
  ProviderId,
  resolveProviderId,
  resolveModelCatalogKey,
  endpointToProvider,
  knownEndpointToProvider,
} from '../src/providers';
import { EModelEndpoint, Providers } from '../src/schemas';
import { KnownEndpoints } from '../src/config';

describe('ProviderId', () => {
  it('declares every value as its own lowercase key', () => {
    for (const [key, value] of Object.entries(ProviderId)) {
      expect(value).toBe(key);
      expect(value).toBe(value.toLowerCase());
    }
  });

  it('contains no dots, so together.ai is together', () => {
    for (const value of Object.values(ProviderId)) {
      expect(value).not.toContain('.');
    }
    expect(ProviderId.together).toBe('together');
  });
});

describe('resolveProviderId', () => {
  it('resolves an exact id', () => {
    expect(resolveProviderId('openrouter')).toBe(ProviderId.openrouter);
  });

  it('is case insensitive', () => {
    expect(resolveProviderId('OpenRouter')).toBe(ProviderId.openrouter);
  });

  it('ignores spaces, dots, dashes and underscores', () => {
    expect(resolveProviderId('together.ai')).toBe(ProviderId.together);
    expect(resolveProviderId('Together AI')).toBe(ProviderId.together);
    expect(resolveProviderId('hugging-face')).toBe(ProviderId.huggingface);
    expect(resolveProviderId('open_router')).toBe(ProviderId.openrouter);
  });

  it('resolves brand aliases to their provider', () => {
    expect(resolveProviderId('claude')).toBe(ProviderId.anthropic);
    expect(resolveProviderId('gemini')).toBe(ProviderId.google);
    expect(resolveProviderId('vertexai')).toBe(ProviderId.google);
    expect(resolveProviderId('grok')).toBe(ProviderId.xai);
    expect(resolveProviderId('kimi')).toBe(ProviderId.moonshot);
    expect(resolveProviderId('AMD Lemonade')).toBe(ProviderId.lemonade);
    expect(resolveProviderId('Lemonade Server')).toBe(ProviderId.lemonade);
  });

  it('returns null for empty and unknown input', () => {
    expect(resolveProviderId('')).toBeNull();
    expect(resolveProviderId(null)).toBeNull();
    expect(resolveProviderId(undefined)).toBeNull();
    expect(resolveProviderId('totally-unknown-vendor')).toBeNull();
  });
});

describe('mapping tables', () => {
  it('maps the five branded first-class endpoints', () => {
    expect(endpointToProvider[EModelEndpoint.openAI]).toBe(ProviderId.openai);
    expect(endpointToProvider[EModelEndpoint.azureOpenAI]).toBe(ProviderId.azure);
    expect(endpointToProvider[EModelEndpoint.anthropic]).toBe(ProviderId.anthropic);
    expect(endpointToProvider[EModelEndpoint.google]).toBe(ProviderId.google);
    expect(endpointToProvider[EModelEndpoint.bedrock]).toBe(ProviderId.bedrock);
  });

  it('leaves entity endpoints unmapped, since they render entity avatars', () => {
    expect(endpointToProvider[EModelEndpoint.agents]).toBeUndefined();
    expect(endpointToProvider[EModelEndpoint.assistants]).toBeUndefined();
    expect(endpointToProvider[EModelEndpoint.azureAssistants]).toBeUndefined();
    expect(endpointToProvider[EModelEndpoint.custom]).toBeUndefined();
  });

  it('covers every KnownEndpoints value', () => {
    for (const known of Object.values(KnownEndpoints)) {
      expect(knownEndpointToProvider[known]).toBeDefined();
    }
    expect(knownEndpointToProvider[KnownEndpoints['together.ai']]).toBe(ProviderId.together);
  });
});

describe('resolveModelCatalogKey', () => {
  it('uses the Google endpoint catalog for Vertex AI', () => {
    expect(resolveModelCatalogKey(Providers.VERTEXAI)).toBe(EModelEndpoint.google);
  });

  it('preserves an exact Vertex AI catalog over the native fallback', () => {
    expect(
      resolveModelCatalogKey(Providers.VERTEXAI, {
        [EModelEndpoint.google]: ['gemini-3.7-flash'],
        [Providers.VERTEXAI]: ['custom-vertex-model'],
      }),
    ).toBe(Providers.VERTEXAI);
  });

  it('preserves providers that own their own catalog', () => {
    expect(resolveModelCatalogKey(EModelEndpoint.google)).toBe(EModelEndpoint.google);
    expect(resolveModelCatalogKey('custom-provider')).toBe('custom-provider');
  });
});
