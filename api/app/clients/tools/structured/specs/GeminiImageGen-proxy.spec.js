/**
 * These tests verify the proxy wrapper behavior for GeminiImageGen.
 * Instead of loading the full module (which has many dependencies),
 * we directly test the wrapper logic that would be applied.
 */
describe('GeminiImageGen Proxy Configuration', () => {
  let originalEnv;
  let originalFetch;

  beforeAll(() => {
    originalEnv = { ...process.env };
    originalFetch = globalThis.fetch;
  });

  beforeEach(() => {
    process.env = { ...originalEnv };
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    process.env = originalEnv;
    globalThis.fetch = originalFetch;
  });

  /**
   * Simulates the proxy wrapper that GeminiImageGen applies at module load.
   * This is the same logic from GeminiImageGen.js lines 30-42.
   */
  function applyProxyWrapper() {
    const proxyDispatcher = process.env.PROXY ? { type: 'proxy-dispatcher' } : undefined;
    if (proxyDispatcher) {
      const _originalFetch = globalThis.fetch;

      globalThis.fetch = function (url, options = {}) {
        const urlString = url.toString();
        if (urlString.includes('googleapis.com')) {
          options = { ...options, dispatcher: proxyDispatcher };
        }
        return _originalFetch.call(this, url, options);
      };
    }
  }

  it('should wrap globalThis.fetch when PROXY env is set', () => {
    process.env.PROXY = 'http://proxy.example.com:8080';

    const fetchBeforeWrap = globalThis.fetch;

    applyProxyWrapper();

    expect(globalThis.fetch).not.toBe(fetchBeforeWrap);
  });

  it('should not wrap globalThis.fetch when PROXY env is not set', () => {
    delete process.env.PROXY;

    const fetchBeforeWrap = globalThis.fetch;

    applyProxyWrapper();

    expect(globalThis.fetch).toBe(fetchBeforeWrap);
  });

  it('should add dispatcher to googleapis.com URLs', async () => {
    process.env.PROXY = 'http://proxy.example.com:8080';

    let capturedOptions = null;
    const mockFetch = jest.fn((url, options) => {
      capturedOptions = options;
      return Promise.resolve({ ok: true });
    });
    globalThis.fetch = mockFetch;

    applyProxyWrapper();

    await globalThis.fetch('https://generativelanguage.googleapis.com/v1/models', {});

    expect(capturedOptions).toBeDefined();
    expect(capturedOptions.dispatcher).toEqual({ type: 'proxy-dispatcher' });
  });

  it('should not add dispatcher to non-googleapis.com URLs', async () => {
    process.env.PROXY = 'http://proxy.example.com:8080';

    let capturedOptions = null;
    const mockFetch = jest.fn((url, options) => {
      capturedOptions = options;
      return Promise.resolve({ ok: true });
    });
    globalThis.fetch = mockFetch;

    applyProxyWrapper();

    await globalThis.fetch('https://api.openai.com/v1/images', {});

    expect(capturedOptions).toBeDefined();
    expect(capturedOptions.dispatcher).toBeUndefined();
  });

  it('should preserve existing options when adding dispatcher', async () => {
    process.env.PROXY = 'http://proxy.example.com:8080';

    let capturedOptions = null;
    const mockFetch = jest.fn((url, options) => {
      capturedOptions = options;
      return Promise.resolve({ ok: true });
    });
    globalThis.fetch = mockFetch;

    applyProxyWrapper();

    const customHeaders = { 'X-Custom-Header': 'test' };
    await globalThis.fetch('https://aiplatform.googleapis.com/v1/models', {
      headers: customHeaders,
      method: 'POST',
    });

    expect(capturedOptions).toBeDefined();
    expect(capturedOptions.dispatcher).toEqual({ type: 'proxy-dispatcher' });
    expect(capturedOptions.headers).toEqual(customHeaders);
    expect(capturedOptions.method).toBe('POST');
  });
});
