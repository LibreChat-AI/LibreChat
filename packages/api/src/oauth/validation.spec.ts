import { AuthTypeEnum } from 'librechat-data-provider';

import { validateActionOAuthEndpoint, validateActionOAuthMetadata } from './validation';

describe('validateActionOAuthEndpoint', () => {
  it('allows HTTPS endpoints on public addresses', async () => {
    await expect(
      validateActionOAuthEndpoint('https://93.184.216.34/oauth/token', 'client_url'),
    ).resolves.toBeUndefined();
  });

  it.each([
    ['HTTP endpoint', 'http://93.184.216.34/oauth/token'],
    ['FTP endpoint', 'ftp://93.184.216.34/oauth/token'],
    ['localhost', 'https://localhost/oauth/token'],
    ['loopback IP', 'https://127.0.0.1/oauth/token'],
    ['private IP', 'https://10.0.0.1/oauth/token'],
    ['link-local IP', 'https://169.254.169.123/oauth/token'],
    ['metadata IP', 'https://169.254.169.254/latest/meta-data'],
    ['internal hostname', 'https://metadata/oauth/token'],
    ['IPv6 loopback', 'https://[::1]/oauth/token'],
  ])('rejects %s', async (_label, url) => {
    await expect(validateActionOAuthEndpoint(url, 'client_url')).rejects.toThrow(
      /Invalid action OAuth client_url/,
    );
  });

  it('rejects unparseable endpoint URLs', async () => {
    await expect(validateActionOAuthEndpoint('not a url', 'authorization_url')).rejects.toThrow(
      /Invalid action OAuth authorization_url/,
    );
  });

  it('allows restricted HTTPS endpoints when explicitly exempted by allowedAddresses', async () => {
    await expect(
      validateActionOAuthEndpoint('https://10.0.0.1/oauth/token', 'client_url', ['10.0.0.1:443']),
    ).resolves.toBeUndefined();
  });

  it('keeps allowedAddresses scoped to the endpoint port', async () => {
    await expect(
      validateActionOAuthEndpoint('https://10.0.0.1:8443/oauth/token', 'client_url', [
        '10.0.0.1:443',
      ]),
    ).rejects.toThrow(/Invalid action OAuth client_url/);
  });
});

describe('validateActionOAuthMetadata', () => {
  it('validates both OAuth authorization and token endpoints', async () => {
    await expect(
      validateActionOAuthMetadata({
        type: AuthTypeEnum.OAuth,
        authorization_url: 'https://93.184.216.34/oauth/authorize',
        client_url: 'https://10.0.0.1/oauth/token',
      }),
    ).rejects.toThrow(/Invalid action OAuth client_url/);
  });

  it('passes allowedAddresses to both OAuth endpoints', async () => {
    await expect(
      validateActionOAuthMetadata(
        {
          type: AuthTypeEnum.OAuth,
          authorization_url: 'https://10.0.0.1/oauth/authorize',
          client_url: 'https://10.0.0.1/oauth/token',
        },
        ['10.0.0.1:443'],
      ),
    ).resolves.toBeUndefined();
  });

  it('ignores non-OAuth auth metadata', async () => {
    await expect(
      validateActionOAuthMetadata({
        type: AuthTypeEnum.ServiceHttp,
        authorization_url: 'http://localhost/oauth/authorize',
        client_url: 'http://localhost/oauth/token',
      }),
    ).resolves.toBeUndefined();
  });
});
