jest.mock('node:dns/promises', () => ({
  lookup: jest.fn(),
}));
jest.mock('node:dns', () => {
  const actual = jest.requireActual('node:dns');
  return {
    ...actual,
    lookup: jest.fn(),
  };
});

import dns from 'node:dns';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import type { LookupFunction } from 'node:net';
import {
  createAzureSoraRequestConfig,
  resolveAzureSoraCredentials,
  validateAzureSoraEndpoint,
} from './azureSora';

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | dns.LookupAddress[],
  family?: number,
) => void;

const mockedLookup = lookup as jest.MockedFunction<typeof lookup>;
const mockedDnsLookup = dns.lookup as jest.MockedFunction<typeof dns.lookup>;
const httpsAgentPrototype = https.Agent.prototype as unknown as {
  createConnection: (options: Record<string, unknown>) => unknown;
};

function mockDnsAddresses(addresses: dns.LookupAddress[]): void {
  mockedLookup.mockResolvedValue(addresses as never);
}

function mockConnectDns(address: string): void {
  mockedDnsLookup.mockImplementation(((
    _hostname: string,
    _options: unknown,
    callback: LookupCallback,
  ) => {
    callback(null, address, 4);
  }) as never);
}

describe('resolveAzureSoraCredentials', () => {
  const userEndpoint = 'https://user-resource.openai.azure.com';
  const serverEndpoint = 'https://admin-resource.openai.azure.com';
  const serverEnvironment = {
    AZURE_SORA_API_KEY: 'server-key',
    AZURE_SORA_ENDPOINT: serverEndpoint,
  };

  it('does not combine a user key with a global endpoint', () => {
    expect(
      resolveAzureSoraCredentials(
        {
          AZURE_SORA_API_KEY: 'user-key',
          AZURE_SORA_ENDPOINT: serverEndpoint,
        },
        serverEnvironment,
      ),
    ).toEqual({ apiKey: 'server-key', endpoint: serverEndpoint });
  });

  it('does not combine a global key with a user endpoint', () => {
    expect(
      resolveAzureSoraCredentials(
        {
          AZURE_SORA_API_KEY: 'server-key',
          AZURE_SORA_ENDPOINT: userEndpoint,
        },
        serverEnvironment,
      ),
    ).toEqual({ apiKey: 'server-key', endpoint: serverEndpoint });
  });

  it('ignores incomplete and blank user or server pairs', () => {
    expect(
      resolveAzureSoraCredentials({ AZURE_SORA_API_KEY: 'user-key', AZURE_SORA_ENDPOINT: '' }, {}),
    ).toEqual({ apiKey: '', endpoint: '' });
    expect(
      resolveAzureSoraCredentials(
        { AZURE_SORA_API_KEY: '', AZURE_SORA_ENDPOINT: userEndpoint },
        {},
      ),
    ).toEqual({ apiKey: '', endpoint: '' });
    expect(
      resolveAzureSoraCredentials(
        { AZURE_SORA_API_KEY: '  ', AZURE_SORA_ENDPOINT: '  ' },
        { AZURE_SORA_API_KEY: '  ', AZURE_SORA_ENDPOINT: '  ' },
      ),
    ).toEqual({ apiKey: '', endpoint: '' });
  });

  it('uses a complete user pair', () => {
    expect(
      resolveAzureSoraCredentials(
        {
          AZURE_SORA_API_KEY: 'user-key',
          AZURE_SORA_ENDPOINT: userEndpoint,
        },
        serverEnvironment,
      ),
    ).toEqual({ apiKey: 'user-key', endpoint: userEndpoint });
  });

  it('prefers a complete user pair over complete server pairs', () => {
    expect(
      resolveAzureSoraCredentials(
        {
          AZURE_SORA_API_KEY: 'preferred-user-key',
          AZURE_SORA_ENDPOINT: 'https://preferred.openai.azure.com',
        },
        {
          ...serverEnvironment,
          AZURE_API_KEY: 'general-server-key',
          AZURE_OPENAI_ENDPOINT: 'https://general.openai.azure.com',
        },
      ),
    ).toEqual({
      apiKey: 'preferred-user-key',
      endpoint: 'https://preferred.openai.azure.com',
    });
  });

  it('uses a complete Sora-specific server pair', () => {
    expect(resolveAzureSoraCredentials({}, serverEnvironment)).toEqual({
      apiKey: 'server-key',
      endpoint: serverEndpoint,
    });
    expect(
      resolveAzureSoraCredentials(
        {
          AZURE_SORA_API_KEY: serverEnvironment.AZURE_SORA_API_KEY,
          AZURE_SORA_ENDPOINT: serverEnvironment.AZURE_SORA_ENDPOINT,
        },
        serverEnvironment,
      ),
    ).toEqual({ apiKey: 'server-key', endpoint: serverEndpoint });
  });

  it('uses a complete general Azure server pair when no Sora-specific pair exists', () => {
    expect(
      resolveAzureSoraCredentials(
        {},
        {
          AZURE_API_KEY: 'general-server-key',
          AZURE_OPENAI_ENDPOINT: 'https://general.openai.azure.com',
        },
      ),
    ).toEqual({
      apiKey: 'general-server-key',
      endpoint: 'https://general.openai.azure.com',
    });
  });

  it('does not combine aliases from different server configurations', () => {
    expect(
      resolveAzureSoraCredentials(
        {},
        {
          AZURE_SORA_API_KEY: 'sora-server-key',
          AZURE_OPENAI_ENDPOINT: 'https://general.openai.azure.com',
        },
      ),
    ).toEqual({ apiKey: '', endpoint: '' });
  });
});

describe('validateAzureSoraEndpoint', () => {
  beforeEach(() => {
    mockedLookup.mockReset();
    mockDnsAddresses([{ address: '20.190.128.1', family: 4 }]);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it.each([
    'https://resource.openai.azure.com',
    'https://resource.openai.azure.us',
    'https://resource.openai.azure.cn',
  ])('accepts an approved Azure OpenAI endpoint: %s', async (endpoint) => {
    await expect(validateAzureSoraEndpoint(endpoint)).resolves.toBe(endpoint);
  });

  it.each([
    'http://resource.openai.azure.com',
    'https://resource.openai.azure.com.evil.example',
    'https://resource.openai.azure.com@127.0.0.1',
    'https://127.0.0.1',
    'https://resource.openai.azure.com:444',
    'https://resource.openai.azure.com/custom',
    'https://resource.openai.azure.com?target=evil.example',
    'not a URL',
  ])('rejects an unsafe endpoint: %s', async (endpoint) => {
    await expect(validateAzureSoraEndpoint(endpoint)).rejects.toThrow(
      'Invalid Azure Sora endpoint',
    );
  });

  it('rejects an approved hostname that resolves to a private address', async () => {
    mockDnsAddresses([{ address: '169.254.169.254', family: 4 }]);

    await expect(validateAzureSoraEndpoint('https://resource.openai.azure.com')).rejects.toThrow(
      'resolves to a restricted address',
    );
  });

  it('rejects a mixed public and private DNS answer', async () => {
    mockDnsAddresses([
      { address: '20.190.128.1', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ]);

    await expect(validateAzureSoraEndpoint('https://resource.openai.azure.com')).rejects.toThrow(
      'resolves to a restricted address',
    );
  });
});

describe('createAzureSoraRequestConfig', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  it('blocks redirects and proxies before attaching connect-time DNS guards', () => {
    const config = createAzureSoraRequestConfig(
      'https://resource.openai.azure.com/openai/v1/video/generations/jobs',
      { headers: { 'api-key': 'server-key' } },
    );

    expect(config.maxRedirects).toBe(0);
    expect(config.proxy).toBe(false);
    expect(config.httpsAgent).toBeDefined();
    expect(config.httpAgent).toBeDefined();
  });

  it('blocks a hostname that rebinds to private space at connect time', () => {
    mockConnectDns('10.0.0.5');
    let lookupError: NodeJS.ErrnoException | null = null;
    jest.spyOn(httpsAgentPrototype, 'createConnection').mockImplementation(((
      options: Record<string, unknown>,
    ) => {
      const lookup = options.lookup as LookupFunction;
      lookup('resource.openai.azure.com', {}, (error) => {
        lookupError = error;
      });
      return {};
    }) as never);

    const config = createAzureSoraRequestConfig(
      'https://resource.openai.azure.com/openai/v1/video/generations/jobs',
      {},
    );
    const httpsAgent = config.httpsAgent as unknown as {
      createConnection: (options: Record<string, unknown>) => unknown;
    };
    httpsAgent.createConnection({
      host: 'resource.openai.azure.com',
      port: 443,
    });

    expect(lookupError).toMatchObject({ code: 'ESSRF' });
    config.httpsAgent?.destroy();
    config.httpAgent?.destroy();
  });
});
