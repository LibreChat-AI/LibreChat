import { normalizeAddressEntry, resolveAllowedAddressesEnv } from './allowedAddresses';
import { isAddressAllowed } from './domain';

const SEARXNG_HOST = 'searxng.search-ns.local';

describe('resolveAllowedAddressesEnv', () => {
  it('resolves a whole-entry reference holding host:port', () => {
    const env = { SEARXNG_ALLOWED_ADDRESS: `${SEARXNG_HOST}:8080` };

    const { addresses, dropped } = resolveAllowedAddressesEnv(['${SEARXNG_ALLOWED_ADDRESS}'], env);

    expect(addresses).toEqual([`${SEARXNG_HOST}:8080`]);
    expect(dropped).toEqual([]);
    expect(isAddressAllowed(SEARXNG_HOST, addresses, 8080)).toBe(true);
    expect(isAddressAllowed(SEARXNG_HOST, addresses, 22)).toBe(false);
  });

  it('resolves a host reference followed by a literal port', () => {
    const env = { FIRECRAWL_HOST: ' firecrawl.scrape-ns.local ' };

    const { addresses } = resolveAllowedAddressesEnv(['${FIRECRAWL_HOST}:3002'], env);

    expect(addresses).toEqual(['firecrawl.scrape-ns.local:3002']);
    expect(isAddressAllowed('firecrawl.scrape-ns.local', addresses, 3002)).toBe(true);
  });

  it('keeps literal entries unchanged and in order', () => {
    const env = { SEARXNG_ALLOWED_ADDRESS: `${SEARXNG_HOST}:8080` };

    const { addresses } = resolveAllowedAddressesEnv(
      ['ollama.internal:11434', '${SEARXNG_ALLOWED_ADDRESS}', '[fd00::1]:8080'],
      env,
    );

    expect(addresses).toEqual(['ollama.internal:11434', `${SEARXNG_HOST}:8080`, '[fd00::1]:8080']);
  });

  it.each([
    ['unset', {}],
    ['empty', { SEARXNG_ALLOWED_ADDRESS: '' }],
    ['blank', { SEARXNG_ALLOWED_ADDRESS: '   ' }],
  ])('drops a reference whose variable is %s and keeps the rest', (_label, env) => {
    const { addresses, dropped } = resolveAllowedAddressesEnv(
      ['${SEARXNG_ALLOWED_ADDRESS}', 'ollama.internal:11434'],
      env,
    );

    expect(addresses).toEqual(['ollama.internal:11434']);
    expect(dropped).toEqual([
      {
        entry: '${SEARXNG_ALLOWED_ADDRESS}',
        varName: 'SEARXNG_ALLOWED_ADDRESS',
        reason: 'unset',
      },
    ]);
  });

  it.each([
    ['a URL', 'http://searxng.internal:8080'],
    ['a host without a port', 'searxng.internal'],
    ['a CIDR range', '10.0.0.0/8:8080'],
    ['a public IP literal', '8.8.8.8:53'],
    ['embedded whitespace', 'searxng internal:8080'],
    ['a nested reference', '${OTHER_ADDRESS}'],
    ['an invalid port', 'searxng.internal:70000'],
  ])('drops a whole-entry reference resolving to %s', (_label, value) => {
    const { addresses, dropped } = resolveAllowedAddressesEnv(['${SEARXNG_ALLOWED_ADDRESS}'], {
      SEARXNG_ALLOWED_ADDRESS: value,
      OTHER_ADDRESS: 'searxng.internal:8080',
    });

    expect(addresses).toEqual([]);
    expect(dropped).toEqual([
      expect.objectContaining({ varName: 'SEARXNG_ALLOWED_ADDRESS', reason: 'invalid' }),
    ]);
  });

  it('drops a host reference whose variable already carries a port', () => {
    const { addresses, dropped } = resolveAllowedAddressesEnv(['${SEARXNG_HOST}:8080'], {
      SEARXNG_HOST: `${SEARXNG_HOST}:8080`,
    });

    expect(addresses).toEqual([]);
    expect(dropped[0]?.reason).toBe('invalid');
  });

  it('never resolves an infrastructure secret', () => {
    const { addresses, dropped } = resolveAllowedAddressesEnv(['${MONGO_URI}'], {
      MONGO_URI: 'mongodb.internal:27017',
    });

    expect(addresses).toEqual([]);
    expect(dropped).toEqual([{ entry: '${MONGO_URI}', varName: 'MONGO_URI', reason: 'sensitive' }]);
  });
});

describe('normalizeAddressEntry with environment references', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, SEARXNG_HOST };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it.each(['${SEARXNG_HOST}:8080', '${SEARXNG_ALLOWED_ADDRESS}', 'searxng{1}:8080', 'a$b:8080'])(
    'drops unresolved %s even when the variable is set, so only the config loader resolves',
    (entry) => {
      expect(normalizeAddressEntry(entry)).toBe('');
      expect(isAddressAllowed(SEARXNG_HOST, [entry], 8080)).toBe(false);
    },
  );

  it('keeps plain literal entries working as before', () => {
    expect(isAddressAllowed('ollama.internal', ['ollama.internal:11434'], 11434)).toBe(true);
    expect(isAddressAllowed('10.0.0.5', ['10.0.0.5:11434'], 11434)).toBe(true);
    expect(isAddressAllowed('ollama.internal', ['ollama.internal'], 11434)).toBe(false);
    expect(isAddressAllowed('8.8.8.8', ['8.8.8.8:53'], 53)).toBe(false);
  });
});
