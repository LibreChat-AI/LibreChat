import { ScraperProviders } from 'librechat-data-provider';
import { resolveWebSearchSSRFAgents } from './agent';
import { isAddressAllowed } from '../auth';

/** `options` exists on a Node agent at runtime but is absent from the bundled type. */
interface AgentOptionsProbe {
  options: { keepAlive?: boolean; timeout?: number };
}

function agentOptions(agent: object): AgentOptionsProbe['options'] {
  return (agent as AgentOptionsProbe).options;
}

/** Drives the seam every request and every redirect hop passes through. */
interface ConnectProbe {
  createConnection: (options: Record<string, unknown>) => unknown;
}

function connectRaw(agent: object, options: Record<string, unknown>): void {
  const socket = (agent as ConnectProbe).createConnection(options);
  (socket as { destroy?: () => void })?.destroy?.();
}

function connect(agent: object, host: string, port: number): void {
  connectRaw(agent, { host, port });
}

const HTTP_DEST = { searxngInstanceUrl: 'http://searxng.internal:8080' };

describe('resolveWebSearchSSRFAgents', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    for (const key of [
      'PROXY',
      'proxy',
      'HTTP_PROXY',
      'http_proxy',
      'HTTPS_PROXY',
      'https_proxy',
      'ALL_PROXY',
      'all_proxy',
      'NO_PROXY',
      'no_proxy',
    ]) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('always returns a pooled agent pair', () => {
    const { httpAgent, httpsAgent } = resolveWebSearchSSRFAgents(HTTP_DEST);

    expect(httpAgent).toBeDefined();
    expect(httpsAgent).toBeDefined();
    expect(agentOptions(httpAgent).keepAlive).toBe(true);
    expect(agentOptions(httpAgent).timeout).toBe(5000);
    expect(agentOptions(httpsAgent).keepAlive).toBe(true);
  });

  it('still returns agents when a proxy is configured, so direct routes stay guarded', () => {
    process.env.HTTPS_PROXY = 'http://proxy.internal:3128';

    const { httpAgent, httpsAgent } = resolveWebSearchSSRFAgents(HTTP_DEST);

    expect(httpAgent).toBeDefined();
    expect(httpsAgent).toBeDefined();
  });

  it('exempts the proxy endpoint so the proxy hop stays reachable', () => {
    process.env.HTTP_PROXY = 'http://proxy.internal:3128';

    resolveWebSearchSSRFAgents(HTTP_DEST);

    expect(isAddressAllowed('proxy.internal', ['proxy.internal:3128'], '3128')).toBe(true);
  });

  it('derives proxy exemptions from a custom Keenable search URL', () => {
    process.env.HTTP_PROXY = 'http://10.11.12.13:3128';

    const { httpAgent } = resolveWebSearchSSRFAgents({
      keenableApiUrl: 'http://keenable-search.internal:8080',
    });

    expect(() => connect(httpAgent, '10.11.12.13', 3128)).not.toThrow();
  });

  it('derives proxy exemptions from the Keenable fetch URL environment override', () => {
    process.env.HTTP_PROXY = 'http://10.11.12.14:3128';
    process.env.KEENABLE_FETCH_URL = 'http://keenable-fetch.internal:8080';

    const { httpAgent } = resolveWebSearchSSRFAgents({
      scraperProvider: ScraperProviders.KEENABLE,
    });

    expect(() => connect(httpAgent, '10.11.12.14', 3128)).not.toThrow();
  });

  it('does not exempt the Keenable fetch proxy for another scraper', () => {
    process.env.HTTP_PROXY = 'http://10.11.12.15:3128';
    process.env.KEENABLE_FETCH_URL = 'http://keenable-fetch.internal:8080';

    const { httpAgent } = resolveWebSearchSSRFAgents({
      scraperProvider: ScraperProviders.FIRECRAWL,
    });

    expect(() => connect(httpAgent, '10.11.12.15', 3128)).toThrow(
      expect.objectContaining({ code: 'ESSRF' }),
    );
  });

  it('scopes the proxy exemption to its port, so another private port stays blocked', () => {
    expect(isAddressAllowed('proxy.internal', ['proxy.internal:3128'], '9')).toBe(false);
  });

  it('derives the default proxy port from the proxy scheme', () => {
    process.env.HTTP_PROXY = 'http://proxy.internal';
    process.env.HTTPS_PROXY = 'https://secure-proxy.internal';

    const first = resolveWebSearchSSRFAgents(HTTP_DEST);

    process.env.HTTP_PROXY = 'http://proxy.internal:80';
    process.env.HTTPS_PROXY = 'https://secure-proxy.internal:443';

    expect(resolveWebSearchSSRFAgents(HTTP_DEST)).toBe(first);
  });

  it('grants no exemption for PROXY, which Axios never reads on this path', () => {
    process.env.PROXY = 'http://10.4.4.4:3128';

    const { httpAgent } = resolveWebSearchSSRFAgents(HTTP_DEST);

    expect(() => connect(httpAgent, '10.4.4.4', 3128)).toThrow(
      expect.objectContaining({ code: 'ESSRF' }),
    );
  });

  it('exempts a scheme-less proxy value, which the resolver normalizes to http', () => {
    process.env.HTTP_PROXY = 'proxy.internal:3128';

    resolveWebSearchSSRFAgents(HTTP_DEST);

    expect(isAddressAllowed('proxy.internal', ['proxy.internal:3128'], '3128')).toBe(true);
  });

  it('exempts a scheme-less literal proxy so the hop stays reachable', () => {
    process.env.HTTP_PROXY = '10.1.2.3:3128';

    const { httpAgent } = resolveWebSearchSSRFAgents(HTTP_DEST);

    expect(() => connect(httpAgent, '10.1.2.3', 3128)).not.toThrow();
  });

  it('exempts only the variable that wins precedence, not every populated one', () => {
    process.env.HTTP_PROXY = 'http://10.1.1.1:3128';
    process.env.HTTPS_PROXY = 'http://10.1.1.1:3128';
    process.env.ALL_PROXY = 'http://10.2.2.2:3128';

    const { httpAgent } = resolveWebSearchSSRFAgents(HTTP_DEST);

    expect(() => connect(httpAgent, '10.1.1.1', 3128)).not.toThrow();
    expect(() => connect(httpAgent, '10.2.2.2', 3128)).toThrow(
      expect.objectContaining({ code: 'ESSRF' }),
    );
  });

  it('prefers the lowercase variable, matching the resolver', () => {
    process.env.http_proxy = 'http://10.3.3.3:3128';
    process.env.HTTP_PROXY = 'http://10.4.4.4:3128';
    process.env.https_proxy = 'http://10.3.3.3:3128';
    process.env.HTTPS_PROXY = 'http://10.3.3.3:3128';

    const { httpAgent } = resolveWebSearchSSRFAgents(HTTP_DEST);

    expect(() => connect(httpAgent, '10.3.3.3', 3128)).not.toThrow();
    expect(() => connect(httpAgent, '10.4.4.4', 3128)).toThrow(
      expect.objectContaining({ code: 'ESSRF' }),
    );
  });

  it('grants no exemption when NO_PROXY covers the destination, since nothing is proxied', () => {
    process.env.HTTP_PROXY = 'http://10.6.6.6:3128';
    process.env.NO_PROXY = 'searxng.internal';

    const { httpAgent } = resolveWebSearchSSRFAgents(HTTP_DEST);

    expect(() => connect(httpAgent, '10.6.6.6', 3128)).toThrow(
      expect.objectContaining({ code: 'ESSRF' }),
    );
  });

  it('exempts the proxy when NO_PROXY does not cover the destination', () => {
    process.env.HTTP_PROXY = 'http://10.7.7.7:3128';
    process.env.NO_PROXY = 'other.internal';

    const { httpAgent } = resolveWebSearchSSRFAgents(HTTP_DEST);

    expect(() => connect(httpAgent, '10.7.7.7', 3128)).not.toThrow();
  });

  it('owes no exemption for an https destination, where Axios tunnels instead', () => {
    process.env.HTTPS_PROXY = 'http://10.8.8.8:3128';

    const { httpAgent } = resolveWebSearchSSRFAgents({
      searxngInstanceUrl: 'https://searx.example.com',
    });

    expect(() => connect(httpAgent, '10.8.8.8', 3128)).toThrow(
      expect.objectContaining({ code: 'ESSRF' }),
    );
  });

  it('grants no exemption for a socks proxy, which Axios cannot use', () => {
    process.env.ALL_PROXY = 'socks5://10.5.5.5:1080';

    const { httpAgent } = resolveWebSearchSSRFAgents(HTTP_DEST);

    expect(() => connect(httpAgent, '10.5.5.5', 1080)).toThrow(
      expect.objectContaining({ code: 'ESSRF' }),
    );
  });

  it('tolerates a non-array allowedAddresses instead of throwing during tool load', () => {
    const asUnknown = { '10.0.0.5:11434': true } as unknown;

    expect(() => resolveWebSearchSSRFAgents(HTTP_DEST, asUnknown as string[])).not.toThrow();
  });

  it('does not collide cache keys when an entry contains a newline', () => {
    const joined = resolveWebSearchSSRFAgents(HTTP_DEST, ['searxng:8080\nfirecrawl:3002']);
    const separate = resolveWebSearchSSRFAgents(HTTP_DEST, ['searxng:8080', 'firecrawl:3002']);

    expect(joined).not.toBe(separate);
  });

  it('rejects a unix socket, which carries no host to validate', () => {
    const { httpAgent } = resolveWebSearchSSRFAgents(HTTP_DEST);

    expect(() => connectRaw(httpAgent, { socketPath: '/tmp/x.sock' })).toThrow(
      expect.objectContaining({ code: 'ESSRF' }),
    );
  });

  it('treats an empty proxy variable as unset, matching the value compose forwards', () => {
    const withoutProxy = resolveWebSearchSSRFAgents(HTTP_DEST);

    process.env.HTTP_PROXY = '';
    process.env.HTTPS_PROXY = '   ';

    expect(resolveWebSearchSSRFAgents(HTTP_DEST)).toBe(withoutProxy);
  });

  it('reuses one pair per exemption list and separates distinct lists', () => {
    const first = resolveWebSearchSSRFAgents(HTTP_DEST, ['searxng:8080']);
    const again = resolveWebSearchSSRFAgents(HTTP_DEST, ['searxng:8080']);
    const other = resolveWebSearchSSRFAgents(HTTP_DEST, ['firecrawl:3002']);

    expect(again).toBe(first);
    expect(other).not.toBe(first);
  });

  it('keeps admin allowedAddresses entries alongside the derived proxy exemption', () => {
    process.env.HTTP_PROXY = 'http://proxy.internal:3128';

    expect(resolveWebSearchSSRFAgents(HTTP_DEST, ['searxng:8080'])).not.toBe(
      resolveWebSearchSSRFAgents(HTTP_DEST, []),
    );
  });

  it('does not throw while building agents, leaving enforcement at connect time', () => {
    expect(() => resolveWebSearchSSRFAgents(HTTP_DEST, ['127.0.0.1:8080'])).not.toThrow();
  });

  it('rejects an IP-literal private host at connect time, covering literal redirect targets', () => {
    const { httpAgent } = resolveWebSearchSSRFAgents(HTTP_DEST);

    expect(() => connect(httpAgent, '169.254.169.254', 80)).toThrow(
      expect.objectContaining({ code: 'ESSRF' }),
    );
    expect(() => connect(httpAgent, '127.0.0.1', 8080)).toThrow(
      expect.objectContaining({ code: 'ESSRF' }),
    );
  });

  it('exempts an IP-literal host listed in allowedAddresses, scoped to its port', () => {
    const { httpAgent } = resolveWebSearchSSRFAgents(HTTP_DEST, ['127.0.0.1:8080']);

    expect(() => connect(httpAgent, '127.0.0.1', 8080)).not.toThrow();
    expect(() => connect(httpAgent, '127.0.0.1', 9)).toThrow(
      expect.objectContaining({ code: 'ESSRF' }),
    );
  });

  it('keeps a literal-address proxy reachable, since the proxy hop is exempted', () => {
    process.env.HTTP_PROXY = 'http://10.1.2.3:3128';

    const { httpAgent } = resolveWebSearchSSRFAgents(HTTP_DEST);

    expect(() => connect(httpAgent, '10.1.2.3', 3128)).not.toThrow();
  });

  it('exempts a proxy configured only through ALL_PROXY, which Axios still honors', () => {
    process.env.ALL_PROXY = 'http://10.1.2.3:3128';

    const { httpAgent } = resolveWebSearchSSRFAgents(HTTP_DEST);

    expect(() => connect(httpAgent, '10.1.2.3', 3128)).not.toThrow();
    expect(() => connect(httpAgent, '10.1.2.3', 9)).toThrow(
      expect.objectContaining({ code: 'ESSRF' }),
    );
  });

  it('exempts a lowercase all_proxy as well, since the resolver is case-insensitive', () => {
    process.env.all_proxy = 'http://10.9.9.9:8080';

    const { httpAgent } = resolveWebSearchSSRFAgents(HTTP_DEST);

    expect(() => connect(httpAgent, '10.9.9.9', 8080)).not.toThrow();
  });

  it('keeps an IPv6-literal proxy reachable, which needs the bracketed exemption form', () => {
    process.env.HTTP_PROXY = 'http://[fd00::1]:3128';

    const { httpAgent } = resolveWebSearchSSRFAgents(HTTP_DEST);

    expect(() => connect(httpAgent, 'fd00::1', 3128)).not.toThrow();
    expect(() => connect(httpAgent, 'fd00::1', 9)).toThrow(
      expect.objectContaining({ code: 'ESSRF' }),
    );
  });

  it('allows a public IP literal', () => {
    const { httpAgent } = resolveWebSearchSSRFAgents(HTTP_DEST);

    expect(() => connect(httpAgent, '93.184.216.34', 80)).not.toThrow();
  });

  it('ignores an unparseable proxy value rather than throwing during tool load', () => {
    process.env.HTTP_PROXY = 'not a url';

    expect(() => resolveWebSearchSSRFAgents(HTTP_DEST)).not.toThrow();
  });
});
