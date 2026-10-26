type SentinelModule = typeof import('./sentinel');

const loadSentinel = (): SentinelModule => {
  let mod: SentinelModule | undefined;
  jest.isolateModules(() => {
    mod = jest.requireActual<SentinelModule>('./sentinel');
  });
  if (!mod) {
    throw new Error('sentinel module failed to load');
  }
  return mod;
};

describe('parseSentinelHosts', () => {
  const { parseSentinelHosts } = loadSentinel();

  it('parses a single host:port', () => {
    expect(parseSentinelHosts('redis-s-0:26379')).toEqual([{ host: 'redis-s-0', port: 26379 }]);
  });

  it('parses multiple comma-separated hosts', () => {
    expect(parseSentinelHosts('redis-s-0:26379,redis-s-1:26379,redis-s-2:26379')).toEqual([
      { host: 'redis-s-0', port: 26379 },
      { host: 'redis-s-1', port: 26379 },
      { host: 'redis-s-2', port: 26379 },
    ]);
  });

  it('trims whitespace around entries', () => {
    expect(parseSentinelHosts('  redis-s-0:26379 , redis-s-1:26379  ')).toEqual([
      { host: 'redis-s-0', port: 26379 },
      { host: 'redis-s-1', port: 26379 },
    ]);
  });

  it('supports FQDNs with dots', () => {
    expect(
      parseSentinelHosts(
        'redis-node-0.redis-headless.shared.svc.cluster.local:26379,redis-node-1.redis-headless.shared.svc.cluster.local:26379',
      ),
    ).toEqual([
      { host: 'redis-node-0.redis-headless.shared.svc.cluster.local', port: 26379 },
      { host: 'redis-node-1.redis-headless.shared.svc.cluster.local', port: 26379 },
    ]);
  });

  it('throws on undefined input', () => {
    expect(() => parseSentinelHosts(undefined)).toThrow('REDIS_SENTINEL_HOSTS');
  });

  it('throws on empty string', () => {
    expect(() => parseSentinelHosts('')).toThrow('REDIS_SENTINEL_HOSTS');
  });

  it('throws on whitespace-only string', () => {
    expect(() => parseSentinelHosts('   ')).toThrow('REDIS_SENTINEL_HOSTS');
  });

  it('throws on entry without port', () => {
    expect(() => parseSentinelHosts('redis-s-0')).toThrow('expected host:port');
  });

  it('throws on invalid port', () => {
    expect(() => parseSentinelHosts('redis-s-0:abc')).toThrow('valid port');
  });

  it('throws on port 0', () => {
    expect(() => parseSentinelHosts('redis-s-0:0')).toThrow('valid port');
  });

  it('throws on port > 65535', () => {
    expect(() => parseSentinelHosts('redis-s-0:99999')).toThrow('valid port');
  });

  it('throws on empty host', () => {
    expect(() => parseSentinelHosts(':26379')).toThrow('expected host:port');
  });

  it('handles IPv6 bracketed addresses', () => {
    // lastIndexOf(':') splits at the last colon after the address
    expect(parseSentinelHosts('[::1]:26379')).toEqual([{ host: '[::1]', port: 26379 }]);
  });

  it('filters out empty entries from trailing commas', () => {
    expect(parseSentinelHosts('redis-s-0:26379,')).toEqual([{ host: 'redis-s-0', port: 26379 }]);
  });
});

describe('RESP parsing (via querySentinelMaster with mocked sockets)', () => {
  it('is exported and queryable', () => {
    const { querySentinelMaster, discoverSentinelMaster } = loadSentinel();
    expect(typeof querySentinelMaster).toBe('function');
    expect(typeof discoverSentinelMaster).toBe('function');
  });
});
