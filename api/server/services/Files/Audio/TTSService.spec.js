jest.mock('axios');
jest.mock('@librechat/data-schemas', () => ({ logger: { warn: jest.fn(), error: jest.fn() } }));
jest.mock('@librechat/api', () => ({
  genAzureEndpoint: jest.fn(),
  logAxiosError: jest.fn(),
  applyAxiosProxyConfig: jest.fn(),
  resolveConfigSecret: jest.fn(),
}));
jest.mock('librechat-data-provider', () => ({
  extractEnvVariable: jest.fn((value) => value),
  /* Real selection logic: these tests are about which provider a schema resolves to. */
  listConfiguredSpeechProviders:
    jest.requireActual('librechat-data-provider').listConfiguredSpeechProviders,
  TTSProviders: {
    OPENAI: 'openai',
    AZURE_OPENAI: 'azureOpenAI',
    ELEVENLABS: 'elevenlabs',
    LOCALAI: 'localai',
  },
}));
jest.mock('./streamAudio', () => ({
  getRandomVoiceId: jest.fn(),
  createChunkProcessor: jest.fn(),
  splitTextIntoChunks: jest.fn(),
}));
jest.mock('~/server/services/Config', () => ({ getAppConfig: jest.fn() }));

const { resolveConfigSecret } = require('@librechat/api');
const { TTSService, getProvider } = require('./TTSService');

describe('TTSService provider header construction with an undecryptable apiKey', () => {
  let service;

  beforeEach(() => {
    service = new TTSService();
    resolveConfigSecret.mockReset();
  });

  it('omits the Authorization header for openAIProvider instead of sending "Bearer undefined"', () => {
    resolveConfigSecret.mockReturnValue(undefined);
    const [, , headers] = service.openAIProvider(
      { apiKey: 'v3:corrupted', voices: [] },
      'hi',
      'alloy',
    );
    expect(headers).not.toHaveProperty('Authorization');
  });

  it('sets the Authorization header normally when the key resolves', () => {
    resolveConfigSecret.mockReturnValue('sk-real-key');
    const [, , headers] = service.openAIProvider({ apiKey: 'v3:ok', voices: [] }, 'hi', 'alloy');
    expect(headers.Authorization).toBe('Bearer sk-real-key');
  });

  it('omits the xi-api-key header for elevenLabsProvider instead of sending "undefined"', () => {
    resolveConfigSecret.mockReturnValue(undefined);
    const [, , headers] = service.elevenLabsProvider(
      { apiKey: 'v3:corrupted', voices: ['ALL'] },
      'hi',
      'voice1',
      false,
    );
    expect(headers).not.toHaveProperty('xi-api-key');
  });

  it('omits the Authorization header for localAIProvider instead of sending "Bearer undefined"', () => {
    resolveConfigSecret.mockReturnValue(undefined);
    const [, , headers] = service.localAIProvider(
      { apiKey: 'v3:corrupted', voices: [] },
      'hi',
      'voice1',
    );
    expect(headers).not.toHaveProperty('Authorization');
  });
});

describe('TTSService getProvider detection', () => {
  const buildConfig = (tts) => ({ speech: { tts } });

  it('resolves exactly one provider when allowedAddresses is set alongside it', async () => {
    const provider = await getProvider(
      buildConfig({
        allowedAddresses: ['localhost:11434'],
        localai: { url: 'http://localhost:11434/tts', apiKey: 'sk' },
      }),
    );
    expect(provider).toBe('localai');
  });

  it('reports "No provider is set" when only allowedAddresses is present', async () => {
    await expect(
      getProvider(buildConfig({ allowedAddresses: ['localhost:11434'] })),
    ).rejects.toThrow('No provider is set');
  });

  it('reports "Multiple providers" when two providers are set even with allowedAddresses', async () => {
    await expect(
      getProvider(
        buildConfig({
          allowedAddresses: ['localhost:11434'],
          openai: { url: 'http://localhost:11434', apiKey: 'sk' },
          localai: { url: 'http://localhost:11434/tts', apiKey: 'sk' },
        }),
      ),
    ).rejects.toThrow('Multiple providers are set');
  });
});
