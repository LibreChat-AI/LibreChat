import type { ConfigOverrideState } from '@librechat/data-schemas';
import { bindSecretDestinations, entersBoundSecret } from './binding';
import { getRebindingIdentity } from '~/app/rebinding';

const STORED = 'v3:00000000000000000000000000000000:abcdef';
const ENTERED = 'v3:11111111111111111111111111111111:abcdef';
const FINGERPRINT = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

function state(overrides: Record<string, unknown>): ConfigOverrideState {
  return { overrides, tombstones: [] } as ConfigOverrideState;
}

const endpointIdentity = (name: string) =>
  getRebindingIdentity(['endpoints', 'custom', name, 'apiKey']);

describe('bindSecretDestinations', () => {
  it('binds a key the request entered to the destination the guard reported, by identity', () => {
    const candidate = state({
      endpoints: { custom: [{ name: 'ollama', apiKey: ENTERED, apiKeyBinding: OTHER }] },
      mcpServers: { tools: { apiKey: { source: 'admin', key: ENTERED } } },
      ocr: { apiKey: ENTERED },
    });
    const destinations = new Map([
      [endpointIdentity('Ollama'), FINGERPRINT],
      [getRebindingIdentity(['mcpServers', 'tools', 'apiKey', 'key']), FINGERPRINT],
    ]);

    const bound = bindSecretDestinations({
      stored: null,
      candidate,
      entered: new Set([ENTERED]),
      destinations,
    });

    expect(bound.overrides).toEqual({
      endpoints: { custom: [{ name: 'ollama', apiKey: ENTERED, apiKeyBinding: FINGERPRINT }] },
      mcpServers: { tools: { apiKey: { source: 'admin', key: ENTERED, keyBinding: FINGERPRINT } } },
      ocr: { apiKey: ENTERED },
    });
    expect(candidate.overrides.endpoints?.custom?.[0]).toHaveProperty('apiKeyBinding', OTHER);
  });

  it('carries the stored fingerprint with a kept key, across a rename too', () => {
    const stored = state({
      endpoints: { custom: [{ name: 'Old', apiKey: STORED, apiKeyBinding: FINGERPRINT }] },
      mcpConfig: {
        tools: { oauth: { client_secret: STORED, client_secretBinding: FINGERPRINT } },
      },
    });
    const candidate = state({
      endpoints: { custom: [{ name: 'New', apiKey: STORED, apiKeyBinding: OTHER }] },
      mcpConfig: { tools: { oauth: { client_secret: STORED } } },
    });

    const bound = bindSecretDestinations({ stored, candidate, entered: new Set() });

    expect(bound.overrides).toEqual({
      endpoints: { custom: [{ name: 'New', apiKey: STORED, apiKeyBinding: FINGERPRINT }] },
      mcpConfig: {
        tools: { oauth: { client_secret: STORED, client_secretBinding: FINGERPRINT } },
      },
    });
  });

  it('removes every fingerprint no key the server bound stands beside', () => {
    const stored = state({
      ocr: { apiKey: STORED },
      endpoints: { custom: [{ name: 'Mine', apiKey: '${MY_KEY}', apiKeyBinding: FINGERPRINT }] },
    });
    const candidate = state({
      ocr: { apiKey: STORED, apiKeyBinding: FINGERPRINT },
      speech: { tts: { openai: { apiKeyBinding: FINGERPRINT } } },
      endpoints: {
        custom: [
          { name: 'Users', apiKey: 'user_provided', apiKeyBinding: FINGERPRINT },
          { name: 'Mine', apiKey: '${OTHER_KEY}', apiKeyBinding: FINGERPRINT },
        ],
        azureOpenAI: {
          groups: [{ group: 'east', apiKey: STORED, apiKeyBinding: FINGERPRINT }],
          groupMap: { east: { apiKeyBinding: FINGERPRINT } },
        },
      },
    });

    const bound = bindSecretDestinations({ stored, candidate, entered: new Set() });

    expect(JSON.stringify(bound.overrides)).not.toContain('Binding');
  });

  it('keeps a reference bound where the same reference was bound before', () => {
    const stored = state({
      endpoints: { custom: [{ name: 'Mine', apiKey: '${MY_KEY}', apiKeyBinding: FINGERPRINT }] },
    });
    const candidate = state({
      endpoints: { custom: [{ name: 'Mine', apiKey: '${MY_KEY}', models: { default: ['m'] } }] },
    });

    const bound = bindSecretDestinations({ stored, candidate, entered: new Set() });

    expect(bound.overrides.endpoints?.custom?.[0]).toHaveProperty('apiKeyBinding', FINGERPRINT);
  });

  it('returns the candidate itself when nothing changes', () => {
    const candidate = state({ ocr: { apiKey: STORED }, interface: { customWelcome: 'hi' } });
    expect(bindSecretDestinations({ stored: candidate, candidate, entered: new Set() })).toBe(
      candidate,
    );
  });
});

describe('entersBoundSecret', () => {
  it('finds a key the request entered at a bound location, and nothing else', () => {
    const candidate = state({
      endpoints: { custom: [{ name: 'Mine', apiKey: ENTERED }] },
      webSearch: { serperApiKey: ENTERED },
    });
    expect(entersBoundSecret(candidate, new Set([ENTERED]))).toBe(true);
    expect(entersBoundSecret(candidate, new Set([STORED]))).toBe(false);
    expect(
      entersBoundSecret(state({ webSearch: { serperApiKey: ENTERED } }), new Set([ENTERED])),
    ).toBe(false);
  });
});
