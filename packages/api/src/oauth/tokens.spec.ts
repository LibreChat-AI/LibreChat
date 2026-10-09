import axios from 'axios';
import { decryptV2 } from '@librechat/data-schemas';
import { TokenExchangeMethodEnum } from 'librechat-data-provider';
import type { AxiosRequestConfig } from 'axios';
import { getAccessToken, refreshAccessToken } from './tokens';

jest.mock('axios');

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    debug: jest.fn(),
    error: jest.fn(),
  },
  encryptV2: jest.fn(async (value: string) => `encrypted:${value}`),
  decryptV2: jest.fn(async (value: string) => {
    if (value === 'encrypted-client-id') {
      return 'client-id';
    }
    if (value === 'encrypted-client-secret') {
      return 'client-secret';
    }
    if (value === 'encrypted-refresh-token') {
      return 'refresh-token';
    }
    if (value === 'encrypted-encoded-client-id') {
      return 'client%40id.com';
    }
    if (value === 'encrypted-encoded-client-secret') {
      return 's%2Bcret%3D%2Fend';
    }
    if (value === 'encrypted-legacy-client-id') {
      return 'legacy%value';
    }
    if (value === 'encrypted-legacy-client-secret') {
      return '100%secret';
    }
    return value;
  }),
}));

const mockedAxios = axios as jest.MockedFunction<typeof axios>;
const mockedDecryptV2 = decryptV2 as jest.MockedFunction<typeof decryptV2>;

function createTokenMethods() {
  return {
    findToken: jest.fn().mockResolvedValue(null),
    updateToken: jest.fn().mockResolvedValue({}),
    createToken: jest.fn().mockResolvedValue({}),
  };
}

function getAxiosConfig(): AxiosRequestConfig {
  const config = mockedAxios.mock.calls[0]?.[0] as AxiosRequestConfig | undefined;
  if (!config) {
    throw new Error('Expected axios to be called');
  }
  return config;
}

describe('action OAuth token exchange validation', () => {
  const tokenResponse = {
    access_token: 'access-token',
    expires_in: 3600,
    refresh_token: 'new-refresh-token',
    refresh_token_expires_in: 7200,
  };

  const baseFields = {
    userId: 'user-1',
    identifier: 'user-1:action-1',
    client_url: 'https://93.184.216.34/oauth/token',
    encrypted_oauth_client_id: 'encrypted-client-id',
    encrypted_oauth_client_secret: 'encrypted-client-secret',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockedAxios.mockResolvedValue({ data: tokenResponse });
  });

  it.each([
    'http://93.184.216.34/oauth/token',
    'https://localhost/oauth/token',
    'https://10.0.0.1/oauth/token',
    'https://169.254.169.254/latest/meta-data',
  ])(
    'rejects unsafe client_url before decrypting secrets or calling axios: %s',
    async (clientUrl) => {
      await expect(
        getAccessToken(
          {
            ...baseFields,
            client_url: clientUrl,
            code: 'authorization-code',
            redirect_uri: 'https://chat.example.com/api/actions/action-1/oauth/callback',
            token_exchange_method: TokenExchangeMethodEnum.DefaultPost,
          },
          createTokenMethods(),
        ),
      ).rejects.toThrow(/Invalid action OAuth client_url/);

      expect(mockedDecryptV2).not.toHaveBeenCalled();
      expect(mockedAxios).not.toHaveBeenCalled();
    },
  );

  it('posts authorization-code exchanges without following redirects', async () => {
    await getAccessToken(
      {
        ...baseFields,
        code: 'authorization-code',
        redirect_uri: 'https://chat.example.com/api/actions/action-1/oauth/callback',
        token_exchange_method: TokenExchangeMethodEnum.DefaultPost,
      },
      createTokenMethods(),
    );

    const config = getAxiosConfig();
    const params = new URLSearchParams(config.data as string);

    expect(config).toEqual(
      expect.objectContaining({
        method: 'POST',
        url: baseFields.client_url,
        maxRedirects: 0,
        httpsAgent: expect.any(Object),
      }),
    );
    expect(params.get('client_id')).toBe('client-id');
    expect(params.get('client_secret')).toBe('client-secret');
  });

  it('uses Basic auth for authorization-code exchanges without putting client secrets in the body', async () => {
    await getAccessToken(
      {
        ...baseFields,
        code: 'authorization-code',
        redirect_uri: 'https://chat.example.com/api/actions/action-1/oauth/callback',
        token_exchange_method: TokenExchangeMethodEnum.BasicAuthHeader,
      },
      createTokenMethods(),
    );

    const config = getAxiosConfig();
    const headers = config.headers as Record<string, string>;
    const params = new URLSearchParams(config.data as string);

    expect(config.maxRedirects).toBe(0);
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from('client-id:client-secret').toString('base64')}`,
    );
    expect(params.has('client_id')).toBe(false);
    expect(params.has('client_secret')).toBe(false);
  });

  it('posts refresh-token exchanges without following redirects', async () => {
    await refreshAccessToken(
      {
        ...baseFields,
        refresh_token: 'refresh-token',
        token_exchange_method: TokenExchangeMethodEnum.DefaultPost,
      },
      createTokenMethods(),
    );

    const config = getAxiosConfig();
    const params = new URLSearchParams(config.data as string);

    expect(config).toEqual(
      expect.objectContaining({
        method: 'POST',
        url: baseFields.client_url,
        maxRedirects: 0,
        httpsAgent: expect.any(Object),
      }),
    );
    expect(params.get('grant_type')).toBe('refresh_token');
    expect(params.get('client_id')).toBe('client-id');
    expect(params.get('client_secret')).toBe('client-secret');
  });

  it('uses Basic auth for refresh-token exchanges without putting client secrets in the body', async () => {
    await refreshAccessToken(
      {
        ...baseFields,
        refresh_token: 'refresh-token',
        token_exchange_method: TokenExchangeMethodEnum.BasicAuthHeader,
      },
      createTokenMethods(),
    );

    const config = getAxiosConfig();
    const headers = config.headers as Record<string, string>;
    const params = new URLSearchParams(config.data as string);

    expect(config.maxRedirects).toBe(0);
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from('client-id:client-secret').toString('base64')}`,
    );
    expect(params.has('client_id')).toBe(false);
    expect(params.has('client_secret')).toBe(false);
  });

  it('reuses the same HTTPS agent across token exchanges', async () => {
    await getAccessToken(
      {
        ...baseFields,
        code: 'authorization-code',
        redirect_uri: 'https://chat.example.com/api/actions/action-1/oauth/callback',
        token_exchange_method: TokenExchangeMethodEnum.DefaultPost,
      },
      createTokenMethods(),
    );
    await refreshAccessToken(
      {
        ...baseFields,
        refresh_token: 'refresh-token',
        token_exchange_method: TokenExchangeMethodEnum.DefaultPost,
      },
      createTokenMethods(),
    );

    const [accessConfig, refreshConfig] = mockedAxios.mock.calls.map(
      ([config]) => config as AxiosRequestConfig,
    );

    expect(accessConfig.httpsAgent).toBe(refreshConfig.httpsAgent);
  });

  describe('URL-encoded stored credentials', () => {
    const encodedFields = {
      ...baseFields,
      encrypted_oauth_client_id: 'encrypted-encoded-client-id',
      encrypted_oauth_client_secret: 'encrypted-encoded-client-secret',
    };

    const legacyFields = {
      ...baseFields,
      encrypted_oauth_client_id: 'encrypted-legacy-client-id',
      encrypted_oauth_client_secret: 'encrypted-legacy-client-secret',
    };

    it('decodes credentials in the authorization-code exchange body', async () => {
      await getAccessToken(
        {
          ...encodedFields,
          code: 'authorization-code',
          redirect_uri: 'https://chat.example.com/api/actions/action-1/oauth/callback',
          token_exchange_method: TokenExchangeMethodEnum.DefaultPost,
        },
        createTokenMethods(),
      );

      const params = new URLSearchParams(getAxiosConfig().data as string);

      expect(params.get('client_id')).toBe('client@id.com');
      expect(params.get('client_secret')).toBe('s+cret=/end');
    });

    it('decodes credentials in the authorization-code Basic auth header', async () => {
      await getAccessToken(
        {
          ...encodedFields,
          code: 'authorization-code',
          redirect_uri: 'https://chat.example.com/api/actions/action-1/oauth/callback',
          token_exchange_method: TokenExchangeMethodEnum.BasicAuthHeader,
        },
        createTokenMethods(),
      );

      const headers = getAxiosConfig().headers as Record<string, string>;
      const credentials = Buffer.from(
        headers.Authorization.replace('Basic ', ''),
        'base64',
      ).toString('utf8');

      expect(credentials).toBe('client@id.com:s+cret=/end');
    });

    it('decodes credentials in the refresh-token exchange body', async () => {
      await refreshAccessToken(
        {
          ...encodedFields,
          refresh_token: 'refresh-token',
          token_exchange_method: TokenExchangeMethodEnum.DefaultPost,
        },
        createTokenMethods(),
      );

      const params = new URLSearchParams(getAxiosConfig().data as string);

      expect(params.get('client_id')).toBe('client@id.com');
      expect(params.get('client_secret')).toBe('s+cret=/end');
    });

    it('decodes credentials in the refresh-token Basic auth header', async () => {
      await refreshAccessToken(
        {
          ...encodedFields,
          refresh_token: 'refresh-token',
          token_exchange_method: TokenExchangeMethodEnum.BasicAuthHeader,
        },
        createTokenMethods(),
      );

      const headers = getAxiosConfig().headers as Record<string, string>;
      const credentials = Buffer.from(
        headers.Authorization.replace('Basic ', ''),
        'base64',
      ).toString('utf8');

      expect(credentials).toBe('client@id.com:s+cret=/end');
    });

    it('passes through legacy unencoded credentials containing a stray percent sign', async () => {
      await expect(
        getAccessToken(
          {
            ...legacyFields,
            code: 'authorization-code',
            redirect_uri: 'https://chat.example.com/api/actions/action-1/oauth/callback',
            token_exchange_method: TokenExchangeMethodEnum.DefaultPost,
          },
          createTokenMethods(),
        ),
      ).resolves.toEqual(tokenResponse);

      const params = new URLSearchParams(getAxiosConfig().data as string);

      expect(params.get('client_id')).toBe('legacy%value');
      expect(params.get('client_secret')).toBe('100%secret');
    });

    it('passes through legacy unencoded credentials when refreshing', async () => {
      await expect(
        refreshAccessToken(
          {
            ...legacyFields,
            refresh_token: 'refresh-token',
            token_exchange_method: TokenExchangeMethodEnum.BasicAuthHeader,
          },
          createTokenMethods(),
        ),
      ).resolves.toEqual(tokenResponse);

      const headers = getAxiosConfig().headers as Record<string, string>;
      const credentials = Buffer.from(
        headers.Authorization.replace('Basic ', ''),
        'base64',
      ).toString('utf8');

      expect(credentials).toBe('legacy%value:100%secret');
    });
  });

  it('allows explicitly exempted private token endpoints', async () => {
    await getAccessToken(
      {
        ...baseFields,
        client_url: 'https://10.0.0.1/oauth/token',
        code: 'authorization-code',
        redirect_uri: 'https://chat.example.com/api/actions/action-1/oauth/callback',
        token_exchange_method: TokenExchangeMethodEnum.DefaultPost,
        allowedAddresses: ['10.0.0.1:443'],
      },
      createTokenMethods(),
    );

    expect(getAxiosConfig().url).toBe('https://10.0.0.1/oauth/token');
  });
});
