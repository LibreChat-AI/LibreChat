const DALLE3 = require('../DALLE3');

const processFileURL = jest.fn();
const proxyEnvKeys = [
  'PROXY',
  'proxy',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
];

function clearProxyEnv() {
  proxyEnvKeys.forEach((key) => delete process.env[key]);
}

describe('DALLE3 Proxy Configuration', () => {
  let originalEnv;

  beforeAll(() => {
    originalEnv = { ...process.env };
  });

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    clearProxyEnv();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should configure fetchOptions.dispatcher when proxy env is set', () => {
    // Set proxy environment variable
    process.env.PROXY = 'http://proxy.example.com:8080';
    process.env.DALLE_API_KEY = 'test-api-key';

    // Create instance
    const dalleWithProxy = new DALLE3({ processFileURL });

    // Check that the openai client exists
    expect(dalleWithProxy.openai).toBeDefined();

    // Check that _options exists and has fetchOptions with a dispatcher
    expect(dalleWithProxy.openai._options).toBeDefined();
    expect(dalleWithProxy.openai._options.fetchOptions).toBeDefined();
    expect(dalleWithProxy.openai._options.fetchOptions.dispatcher).toBeDefined();
    expect(dalleWithProxy.openai._options.fetchOptions.dispatcher).toBeDefined();
  });

  it('should not configure a dispatcher when proxy env is not set', () => {
    process.env.DALLE_API_KEY = 'test-api-key';

    // Create instance
    const dalleWithoutProxy = new DALLE3({ processFileURL });

    // Check that the openai client exists
    expect(dalleWithoutProxy.openai).toBeDefined();

    // Check that _options exists but fetchOptions either doesn't exist or doesn't have a dispatcher
    expect(dalleWithoutProxy.openai._options).toBeDefined();

    // fetchOptions should either not exist or not have a dispatcher
    if (dalleWithoutProxy.openai._options.fetchOptions) {
      expect(dalleWithoutProxy.openai._options.fetchOptions.dispatcher).toBeUndefined();
    }
  });
});
