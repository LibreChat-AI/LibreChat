import { HttpsProxyAgent } from 'https-proxy-agent';
import { Agent, EnvHttpProxyAgent, ProxyAgent } from 'undici';
import {
  applyAxiosProxyConfig,
  getDirectDispatcher,
  getEnvProxyDispatcher,
  getHttpsProxyAgent,
  getProxyDispatcher,
  getProxyEnvConfig,
  getProxyUrlForUrl,
  shouldBypassProxy,
} from './proxy';

jest.mock('https-proxy-agent', () => ({
  HttpsProxyAgent: jest.fn(),
}));

jest.mock('undici', () => ({
  Agent: jest.fn(),
  EnvHttpProxyAgent: jest.fn(),
  ProxyAgent: jest.fn(),
}));

const MockAgent = Agent as jest.MockedClass<typeof Agent>;
const MockEnvHttpProxyAgent = EnvHttpProxyAgent as jest.MockedClass<typeof EnvHttpProxyAgent>;
const MockProxyAgent = ProxyAgent as jest.MockedClass<typeof ProxyAgent>;
const MockHttpsProxyAgent = HttpsProxyAgent as jest.MockedClass<typeof HttpsProxyAgent>;

describe('proxy helpers', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.PROXY;
    delete process.env.proxy;
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.NO_PROXY;
    delete process.env.http_proxy;
    delete process.env.https_proxy;
    delete process.env.no_proxy;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('reuses direct dispatchers with the same transport timeout policy', () => {
    const options = { bodyTimeout: 0, headersTimeout: 300_000 };

    const first = getDirectDispatcher(options);
    const second = getDirectDispatcher(options);

    expect(second).toBe(first);
    expect(MockAgent).toHaveBeenCalledTimes(1);
    expect(MockAgent).toHaveBeenCalledWith(options);
  });

  it('keys only supported timeout options and discards unkeyed connection callbacks', () => {
    const options = { bodyTimeout: 123_456, headersTimeout: 654_321, connect: jest.fn() };
    const direct = getDirectDispatcher(options);
    expect(getDirectDispatcher({ headersTimeout: 654_321, bodyTimeout: 123_456 })).toBe(direct);
    expect(MockAgent).toHaveBeenLastCalledWith({ bodyTimeout: 123_456, headersTimeout: 654_321 });

    getProxyDispatcher('http://sanitized-proxy:8080', options);
    expect(MockProxyAgent).toHaveBeenLastCalledWith({
      uri: 'http://sanitized-proxy:8080',
      bodyTimeout: 123_456,
      headersTimeout: 654_321,
    });
    process.env.PROXY = 'http://sanitized-env-proxy:8080';
    getEnvProxyDispatcher(options);
    expect(MockEnvHttpProxyAgent).toHaveBeenLastCalledWith({
      httpProxy: 'http://sanitized-env-proxy:8080',
      httpsProxy: 'http://sanitized-env-proxy:8080',
      noProxy: undefined,
      bodyTimeout: 123_456,
      headersTimeout: 654_321,
    });
  });

  it('returns undefined when no proxy env is configured', () => {
    expect(getProxyEnvConfig()).toBeUndefined();
    expect(getEnvProxyDispatcher()).toBeUndefined();
    expect(MockEnvHttpProxyAgent).not.toHaveBeenCalled();
  });

  it('uses PROXY for both protocols and passes no_proxy through to undici', () => {
    process.env.PROXY = 'http://corporate-proxy:8080';
    process.env.no_proxy = 'localhost,.internal.example';

    expect(getProxyEnvConfig()).toEqual({
      httpProxy: 'http://corporate-proxy:8080',
      httpsProxy: 'http://corporate-proxy:8080',
      noProxy: 'localhost,.internal.example',
    });

    expect(getEnvProxyDispatcher()).toBeInstanceOf(EnvHttpProxyAgent);
    expect(MockEnvHttpProxyAgent).toHaveBeenCalledWith({
      httpProxy: 'http://corporate-proxy:8080',
      httpsProxy: 'http://corporate-proxy:8080',
      noProxy: 'localhost,.internal.example',
    });
  });

  it('uses lowercase standard proxy env before uppercase values', () => {
    process.env.HTTP_PROXY = 'http://upper-http:8080';
    process.env.HTTPS_PROXY = 'http://upper-https:8080';
    process.env.NO_PROXY = 'upper.example';
    process.env.http_proxy = 'http://lower-http:8080';
    process.env.https_proxy = 'http://lower-https:8080';
    process.env.no_proxy = 'lower.example';

    expect(getProxyEnvConfig()).toEqual({
      httpProxy: 'http://lower-http:8080',
      httpsProxy: 'http://lower-https:8080',
      noProxy: 'lower.example',
    });
  });

  it('reuses the env dispatcher until proxy env changes', () => {
    process.env.PROXY = 'http://corporate-proxy-reuse:8080';
    process.env.NO_PROXY = 'localhost';

    const first = getEnvProxyDispatcher();
    const second = getEnvProxyDispatcher();

    expect(second).toBe(first);
    expect(MockEnvHttpProxyAgent).toHaveBeenCalledTimes(1);

    process.env.NO_PROXY = 'localhost,.internal.example';
    getEnvProxyDispatcher();

    expect(MockEnvHttpProxyAgent).toHaveBeenCalledTimes(2);
  });

  it('creates explicit proxy dispatchers when a non-env proxy is provided', () => {
    const first = getProxyDispatcher('http://explicit-proxy:8080');
    const second = getProxyDispatcher('http://explicit-proxy:8080');

    expect(second).toBe(first);
    expect(MockProxyAgent).toHaveBeenCalledTimes(1);
    expect(MockProxyAgent).toHaveBeenCalledWith('http://explicit-proxy:8080');
  });

  it('keys proxy dispatchers by transport options', () => {
    const proxy = 'http://timeout-proxy:8080';

    const defaultDispatcher = getProxyDispatcher(proxy);
    const longStreamDispatcher = getProxyDispatcher(proxy, {
      bodyTimeout: 0,
      headersTimeout: 300_000,
    });
    const repeatedLongStreamDispatcher = getProxyDispatcher(proxy, {
      bodyTimeout: 0,
      headersTimeout: 300_000,
    });

    expect(longStreamDispatcher).not.toBe(defaultDispatcher);
    expect(repeatedLongStreamDispatcher).toBe(longStreamDispatcher);
    expect(MockProxyAgent).toHaveBeenLastCalledWith({
      uri: proxy,
      bodyTimeout: 0,
      headersTimeout: 300_000,
    });
  });

  it('uses the env dispatcher when the explicit proxy matches PROXY', () => {
    process.env.PROXY = 'http://matching-proxy:8080';

    getProxyDispatcher('http://matching-proxy:8080');

    expect(MockEnvHttpProxyAgent).toHaveBeenCalledWith({
      httpProxy: 'http://matching-proxy:8080',
      httpsProxy: 'http://matching-proxy:8080',
      noProxy: undefined,
    });
    expect(MockProxyAgent).not.toHaveBeenCalled();
  });

  it('matches NO_PROXY wildcard, domains, host ports, and whitespace separators', () => {
    const noProxy = 'localhost, .internal.example api.example.com:8443 *.service.local *wild.local';

    expect(shouldBypassProxy('https://localhost/login', noProxy)).toBe(true);
    expect(shouldBypassProxy('https://sso.internal.example/login', noProxy)).toBe(true);
    expect(shouldBypassProxy('https://api.example.com:8443/models', noProxy)).toBe(true);
    expect(shouldBypassProxy('https://api.example.com/models', noProxy)).toBe(false);
    expect(shouldBypassProxy('https://foo.service.local/search', noProxy)).toBe(true);
    expect(shouldBypassProxy('https://api.wild.local/search', noProxy)).toBe(true);
    expect(shouldBypassProxy('https://example.com', '*')).toBe(true);
  });

  it('resolves target-aware proxy URLs and respects NO_PROXY for axios-style agents', () => {
    process.env.HTTP_PROXY = 'http://http-proxy:8080';
    process.env.HTTPS_PROXY = 'http://https-proxy:8080';
    process.env.NO_PROXY = 'internal.example';

    expect(getProxyUrlForUrl('http://api.external.example/models')).toBe('http://http-proxy:8080');
    expect(getProxyUrlForUrl('https://api.external.example/models')).toBe(
      'http://https-proxy:8080',
    );
    expect(getProxyUrlForUrl('https://sso.internal.example/login')).toBeUndefined();
  });

  it('falls back to HTTP_PROXY for HTTPS axios-style agents', () => {
    process.env.HTTP_PROXY = 'http://single-proxy:8080';

    expect(getProxyUrlForUrl('https://api.external.example/models')).toBe(
      'http://single-proxy:8080',
    );

    const config = applyAxiosProxyConfig({}, 'https://api.external.example/models');

    expect(config).toEqual({
      httpsAgent: expect.any(Object),
      proxy: false,
    });
    expect(MockHttpsProxyAgent).toHaveBeenCalledWith('http://single-proxy:8080');
  });

  it('applies cached HttpsProxyAgent and disables axios native proxy handling', () => {
    process.env.HTTPS_PROXY = 'http://https-proxy:8080';

    const config = applyAxiosProxyConfig({}, 'https://api.external.example/models');
    const agent = getHttpsProxyAgent('https://api.external.example/models');

    expect(config).toEqual({
      httpsAgent: agent,
      proxy: false,
    });
    expect(MockHttpsProxyAgent).toHaveBeenCalledTimes(1);
    expect(MockHttpsProxyAgent).toHaveBeenCalledWith('http://https-proxy:8080');
  });

  it('disables axios native proxy handling for NO_PROXY targets', () => {
    process.env.proxy = 'http://axios-default-proxy:8080';
    process.env.NO_PROXY = 'internal.example';

    expect(applyAxiosProxyConfig({}, 'https://sso.internal.example/login')).toEqual({
      proxy: false,
    });
    expect(MockHttpsProxyAgent).not.toHaveBeenCalled();
  });

  it('applies axios native proxy config to plain HTTP targets', () => {
    process.env.HTTP_PROXY = 'http://http-proxy:8080';

    expect(applyAxiosProxyConfig({}, 'http://api.external.example/models')).toEqual({
      proxy: {
        host: 'http-proxy',
        port: 8080,
        protocol: 'http',
      },
    });
    expect(MockHttpsProxyAgent).not.toHaveBeenCalled();
  });
});
