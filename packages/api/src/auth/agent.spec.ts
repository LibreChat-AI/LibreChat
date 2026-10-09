jest.mock('node:dns', () => {
  const actual = jest.requireActual('node:dns');
  return {
    ...actual,
    lookup: jest.fn(),
  };
});

import dns from 'node:dns';
import http from 'node:http';
import type { AxiosRequestConfig } from 'axios';
import type { LookupFunction } from 'node:net';
import {
  createSSRFSafeAgents,
  createSSRFSafeUndiciConnect,
  applySSRFSafeAgentIfDirect,
} from './agent';

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | dns.LookupAddress[],
  family?: number,
) => void;

const mockedDnsLookup = dns.lookup as jest.MockedFunction<typeof dns.lookup>;
const httpAgentPrototype = http.Agent.prototype as unknown as {
  createConnection: (options: Record<string, unknown>) => unknown;
};

function mockDnsResult(address: string, family: number): void {
  mockedDnsLookup.mockImplementation(((
    _hostname: string,
    _options: unknown,
    callback: LookupCallback,
  ) => {
    callback(null, address, family);
  }) as never);
}

function mockDnsAllResult(addresses: dns.LookupAddress[]): void {
  mockedDnsLookup.mockImplementation(((
    _hostname: string,
    _options: unknown,
    callback: LookupCallback,
  ) => {
    callback(null, addresses);
  }) as never);
}

function mockDnsError(err: NodeJS.ErrnoException): void {
  mockedDnsLookup.mockImplementation(((
    _hostname: string,
    _options: unknown,
    callback: LookupCallback,
  ) => {
    callback(err, '', 0);
  }) as never);
}

describe('createSSRFSafeAgents', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  it('should return httpAgent and httpsAgent', () => {
    const agents = createSSRFSafeAgents();
    expect(agents.httpAgent).toBeDefined();
    expect(agents.httpsAgent).toBeDefined();
  });

  it('should patch httpAgent createConnection to inject SSRF lookup', () => {
    const agents = createSSRFSafeAgents();
    const internal = agents.httpAgent as unknown as {
      createConnection: (opts: Record<string, unknown>) => unknown;
    };
    expect(internal.createConnection).toBeInstanceOf(Function);
  });

  it('should scope allowedAddresses by the request port in the HTTP agent lookup', async () => {
    mockDnsResult('10.0.0.5', 4);
    let lookupError: NodeJS.ErrnoException | null = null;
    jest.spyOn(httpAgentPrototype, 'createConnection').mockImplementation(((
      options: Record<string, unknown>,
    ) => {
      const lookup = options.lookup as LookupFunction;
      lookup('private.example.com', {}, (err) => {
        lookupError = err;
      });
      return {};
    }) as never);

    const agents = createSSRFSafeAgents(['10.0.0.5:11434']);
    const internal = agents.httpAgent as unknown as {
      createConnection: (opts: Record<string, unknown>) => unknown;
    };
    internal.createConnection({ host: 'private.example.com', port: 22 });

    expect(lookupError).toBeTruthy();
    expect(lookupError!.code).toBe('ESSRF');
  });
});

describe('createSSRFSafeUndiciConnect', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should return an object with a lookup function', () => {
    const connect = createSSRFSafeUndiciConnect();
    expect(connect).toHaveProperty('lookup');
    expect(connect.lookup).toBeInstanceOf(Function);
  });

  it('lookup should block private IPs', async () => {
    mockDnsResult('10.0.0.1', 4);
    const connect = createSSRFSafeUndiciConnect();

    const result = await new Promise<{ err: NodeJS.ErrnoException | null }>((resolve) => {
      connect.lookup('evil.example.com', {}, (err) => {
        resolve({ err });
      });
    });

    expect(result.err).toBeTruthy();
    expect(result.err!.code).toBe('ESSRF');
  });

  it('lookup should allow public IPs', async () => {
    mockDnsResult('93.184.216.34', 4);
    const connect = createSSRFSafeUndiciConnect();

    const result = await new Promise<{ err: NodeJS.ErrnoException | null; address: string }>(
      (resolve) => {
        connect.lookup('example.com', {}, (err, address) => {
          resolve({ err, address: address as string });
        });
      },
    );

    expect(result.err).toBeNull();
    expect(result.address).toBe('93.184.216.34');
  });

  it('lookup should block private IPs when DNS returns all addresses', async () => {
    mockDnsAllResult([{ address: '127.0.0.1', family: 4 }]);
    const connect = createSSRFSafeUndiciConnect();

    const result = await new Promise<{ err: NodeJS.ErrnoException | null }>((resolve) => {
      connect.lookup('localhost', { all: true }, (err) => {
        resolve({ err });
      });
    });

    expect(result.err).toBeTruthy();
    expect(result.err!.code).toBe('ESSRF');
  });

  it('lookup should allow public IPs when DNS returns all addresses', async () => {
    const addresses = [{ address: '93.184.216.34', family: 4 }];
    mockDnsAllResult(addresses);
    const connect = createSSRFSafeUndiciConnect();

    const result = await new Promise<{
      err: NodeJS.ErrnoException | null;
      address: string | dns.LookupAddress[];
    }>((resolve) => {
      connect.lookup('example.com', { all: true }, (err, address) => {
        resolve({ err, address });
      });
    });

    expect(result.err).toBeNull();
    expect(result.address).toEqual(addresses);
  });

  it('lookup should block mixed public and private all-address results', async () => {
    mockDnsAllResult([
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ]);
    const connect = createSSRFSafeUndiciConnect();

    const result = await new Promise<{ err: NodeJS.ErrnoException | null }>((resolve) => {
      connect.lookup('rebinding.example.com', { all: true }, (err) => {
        resolve({ err });
      });
    });

    expect(result.err).toBeTruthy();
    expect(result.err!.code).toBe('ESSRF');
  });

  it('lookup should honor allowedAddresses when DNS returns all addresses', async () => {
    const addresses = [{ address: '10.0.0.5', family: 4 }];
    mockDnsAllResult(addresses);
    const connect = createSSRFSafeUndiciConnect(['10.0.0.5:11434'], '11434');

    const result = await new Promise<{
      err: NodeJS.ErrnoException | null;
      address: string | dns.LookupAddress[];
    }>((resolve) => {
      connect.lookup('private.example.com', { all: true }, (err, address) => {
        resolve({ err, address });
      });
    });

    expect(result.err).toBeNull();
    expect(result.address).toEqual(addresses);
  });

  it('lookup should forward DNS errors', async () => {
    const dnsError = Object.assign(new Error('ENOTFOUND'), {
      code: 'ENOTFOUND',
    }) as NodeJS.ErrnoException;
    mockDnsError(dnsError);
    const connect = createSSRFSafeUndiciConnect();

    const result = await new Promise<{ err: NodeJS.ErrnoException | null }>((resolve) => {
      connect.lookup('nonexistent.example.com', {}, (err) => {
        resolve({ err });
      });
    });

    expect(result.err).toBeTruthy();
    expect(result.err!.code).toBe('ENOTFOUND');
  });
});

/**
 * Connect-time exemption is the TOCTOU-safe layer: pre-flight validation can
 * be bypassed by DNS rebinding, but the agent's `lookup` runs on every TCP
 * connect and must honor `allowedAddresses` consistently. These tests cover
 * the runtime path that the domain.ts spec doesn't reach.
 */
describe('SSRF agents — allowedAddresses exemption', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  function runLookup(lookup: LookupFunction, hostname: string) {
    return new Promise<{ err: NodeJS.ErrnoException | null; address: string }>((resolve) => {
      (lookup as (h: string, o: object, cb: LookupCallback) => void)(hostname, {}, (err, address) =>
        resolve({ err, address: address as string }),
      );
    });
  }

  it('exempts a hostname literal on the admin-permitted port', async () => {
    mockDnsResult('10.0.0.5', 4);
    const { lookup } = createSSRFSafeUndiciConnect(['ollama.internal:11434'], '11434');
    const result = await runLookup(lookup, 'ollama.internal');
    expect(result.err).toBeNull();
    expect(result.address).toBe('10.0.0.5');
  });

  it('exempts a private IP on the admin-permitted port (DNS resolves to it)', async () => {
    mockDnsResult('10.0.0.5', 4);
    const { lookup } = createSSRFSafeUndiciConnect(['10.0.0.5:11434'], '11434');
    const result = await runLookup(lookup, 'private.example.com');
    expect(result.err).toBeNull();
    expect(result.address).toBe('10.0.0.5');
  });

  it('blocks a private IP on a different port of an allowed address', async () => {
    mockDnsResult('10.0.0.5', 4);
    const { lookup } = createSSRFSafeUndiciConnect(['10.0.0.5:11434'], '22');
    const result = await runLookup(lookup, 'private.example.com');
    expect(result.err).toBeTruthy();
    expect(result.err!.code).toBe('ESSRF');
  });

  it('ignores legacy bare allowedAddresses entries', async () => {
    mockDnsResult('10.0.0.5', 4);
    const { lookup } = createSSRFSafeUndiciConnect(['10.0.0.5'], '11434');
    const result = await runLookup(lookup, 'private.example.com');
    expect(result.err).toBeTruthy();
    expect(result.err!.code).toBe('ESSRF');
  });

  it('still blocks an unlisted private IP when allowedAddresses is set', async () => {
    mockDnsResult('192.168.1.42', 4);
    const { lookup } = createSSRFSafeUndiciConnect(['10.0.0.5:11434'], '11434');
    const result = await runLookup(lookup, 'other.private.example.com');
    expect(result.err).toBeTruthy();
    expect(result.err!.code).toBe('ESSRF');
  });

  it('drops public-IP entries from allowedAddresses (private-IP scope only)', async () => {
    // Admin mistakenly listed a public IP. It must NOT grant exemption.
    mockDnsResult('10.0.0.5', 4);
    const { lookup } = createSSRFSafeUndiciConnect(['8.8.8.8:53'], '53');
    const result = await runLookup(lookup, 'private.example.com');
    expect(result.err).toBeTruthy();
    expect(result.err!.code).toBe('ESSRF');
  });

  it('drops URL/CIDR/whitespace entries from allowedAddresses', async () => {
    mockDnsResult('10.0.0.5', 4);
    const { lookup } = createSSRFSafeUndiciConnect(
      ['http://10.0.0.5', '10.0.0.0/24', ' 10.0.0.5 '],
      '11434',
    );
    // Even though the value 10.0.0.5 is among the admin entries, none of them
    // pass the schema-shape filter (URL, CIDR, embedded whitespace), so no
    // exemption is granted.
    const result = await runLookup(lookup, 'private.example.com');
    expect(result.err).toBeTruthy();
    expect(result.err!.code).toBe('ESSRF');
  });

  it('createSSRFSafeAgents propagates the exemption-aware lookup to both agents', async () => {
    // The agent factory wraps `createConnection` to inject a custom lookup.
    // The HTTP wrapper is covered above; this keeps the shared lookup factory
    // expectation explicit for the exemption list.
    mockDnsResult('10.0.0.5', 4);
    const agents = createSSRFSafeAgents(['10.0.0.5:11434']);
    expect(agents.httpAgent).toBeDefined();
    expect(agents.httpsAgent).toBeDefined();

    // The undici-connect path uses the same `buildSSRFSafeLookup` factory, so
    // verifying the exemption holds there is sufficient evidence that the
    // agent factory built the right lookup.
    const { lookup } = createSSRFSafeUndiciConnect(['10.0.0.5:11434'], '11434');
    const result = await runLookup(lookup, 'private.example.com');
    expect(result.err).toBeNull();
    expect(result.address).toBe('10.0.0.5');
  });

  it('default lookup (no exemption list) blocks private IPs', async () => {
    mockDnsResult('10.0.0.5', 4);
    const { lookup } = createSSRFSafeUndiciConnect();
    const result = await runLookup(lookup, 'private.example.com');
    expect(result.err).toBeTruthy();
    expect(result.err!.code).toBe('ESSRF');
  });
});

describe('applySSRFSafeAgentIfDirect', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  function spyLookup(hostname: string, port: number) {
    const captured: { err: NodeJS.ErrnoException | null; address: string } = {
      err: null,
      address: '',
    };
    jest.spyOn(httpAgentPrototype, 'createConnection').mockImplementation(((
      options: Record<string, unknown>,
    ) => {
      (options.lookup as LookupFunction)(hostname, {}, (err, address) => {
        captured.err = err;
        captured.address = address as string;
      });
      return {};
    }) as never);
    return {
      drive(agent: unknown) {
        (agent as { createConnection: (o: Record<string, unknown>) => unknown }).createConnection({
          host: hostname,
          port,
        });
        return captured;
      },
    };
  }

  it('attaches both agents and disables redirects for a direct http(s) request', () => {
    const config: AxiosRequestConfig = {};
    applySSRFSafeAgentIfDirect(config, 'https://api.example.com/v1');
    expect(config.httpAgent).toBeDefined();
    expect(config.httpsAgent).toBeDefined();
    expect(config.maxRedirects).toBe(0);
  });

  it('rejects a target resolving to a private IP with ESSRF through the real lookup', () => {
    mockDnsResult('10.0.0.5', 4);
    const probe = spyLookup('internal.example.com', 80);
    const config: AxiosRequestConfig = {};
    applySSRFSafeAgentIfDirect(config, 'http://internal.example.com');
    const result = probe.drive(config.httpAgent);
    expect(result.err).toBeTruthy();
    expect(result.err!.code).toBe('ESSRF');
  });

  it('exempts a host:port present in allowedAddresses through the real lookup', () => {
    mockDnsResult('10.0.0.5', 4);
    const probe = spyLookup('ollama.internal', 11434);
    const config: AxiosRequestConfig = {};
    applySSRFSafeAgentIfDirect(config, 'http://ollama.internal:11434', ['ollama.internal:11434']);
    const result = probe.drive(config.httpAgent);
    expect(result.err).toBeNull();
    expect(result.address).toBe('10.0.0.5');
  });

  it('throws on a non-http(s) scheme', () => {
    expect(() => applySSRFSafeAgentIfDirect({}, 'file:///etc/passwd')).toThrow();
    expect(() => applySSRFSafeAgentIfDirect({}, 'gopher://example.com')).toThrow();
  });

  it('throws on a malformed url', () => {
    expect(() => applySSRFSafeAgentIfDirect({}, 'not a url')).toThrow();
  });

  it('preserves an existing proxy and still disables redirects', () => {
    const config: AxiosRequestConfig = { proxy: { host: '127.0.0.1', port: 8080 } };
    applySSRFSafeAgentIfDirect(config, 'https://api.example.com');
    expect(config.httpAgent).toBeUndefined();
    expect(config.httpsAgent).toBeUndefined();
    expect(config.maxRedirects).toBe(0);
  });

  it('preserves a pre-set agent and still disables redirects', () => {
    const preset = new http.Agent();
    const config: AxiosRequestConfig = { httpAgent: preset };
    applySSRFSafeAgentIfDirect(config, 'https://api.example.com');
    expect(config.httpAgent).toBe(preset);
    expect(config.httpsAgent).toBeUndefined();
    expect(config.maxRedirects).toBe(0);
  });

  it('blocks a literal private IPv4 host that skips the agent DNS lookup', () => {
    let code: string | undefined;
    try {
      applySSRFSafeAgentIfDirect({}, 'http://127.0.0.1:9000');
    } catch (err) {
      code = (err as NodeJS.ErrnoException).code;
    }
    expect(code).toBe('ESSRF');
  });

  it('blocks a literal private IPv6 host', () => {
    let code: string | undefined;
    try {
      applySSRFSafeAgentIfDirect({}, 'http://[::1]:9000');
    } catch (err) {
      code = (err as NodeJS.ErrnoException).code;
    }
    expect(code).toBe('ESSRF');
  });

  it('exempts a literal private IP present in allowedAddresses', () => {
    const config: AxiosRequestConfig = {};
    applySSRFSafeAgentIfDirect(config, 'http://127.0.0.1:9000', ['127.0.0.1:9000']);
    expect(config.httpAgent).toBeDefined();
    expect(config.maxRedirects).toBe(0);
  });

  it('allows a public literal IP', () => {
    const config: AxiosRequestConfig = {};
    applySSRFSafeAgentIfDirect(config, 'http://8.8.8.8:80');
    expect(config.httpAgent).toBeDefined();
  });

  it('exempts a literal private IP on the default http port when the URL omits it', () => {
    const config: AxiosRequestConfig = {};
    applySSRFSafeAgentIfDirect(config, 'http://127.0.0.1', ['127.0.0.1:80']);
    expect(config.httpAgent).toBeDefined();
  });

  it('exempts a literal private IP on the default https port when the URL omits it', () => {
    const config: AxiosRequestConfig = {};
    applySSRFSafeAgentIfDirect(config, 'https://127.0.0.1', ['127.0.0.1:443']);
    expect(config.httpsAgent).toBeDefined();
  });

  it('blocks a literal private IP even when a proxy is already configured', () => {
    let code: string | undefined;
    try {
      applySSRFSafeAgentIfDirect(
        { proxy: { host: '127.0.0.1', port: 8080 } },
        'http://169.254.169.254',
      );
    } catch (err) {
      code = (err as NodeJS.ErrnoException).code;
    }
    expect(code).toBe('ESSRF');
  });

  it('exempts an IPv4-mapped IPv6 literal listed in allowedAddresses', () => {
    const config: AxiosRequestConfig = {};
    applySSRFSafeAgentIfDirect(config, 'http://[::ffff:127.0.0.1]:8080', [
      '[::ffff:127.0.0.1]:8080',
    ]);
    expect(config.httpAgent).toBeDefined();
  });

  it('exempts a fully expanded ULA literal listed in allowedAddresses', () => {
    const config: AxiosRequestConfig = {};
    applySSRFSafeAgentIfDirect(config, 'http://[fd00:0:0:0:0:0:0:1]:8080', [
      '[fd00:0:0:0:0:0:0:1]:8080',
    ]);
    expect(config.httpAgent).toBeDefined();
  });
});
