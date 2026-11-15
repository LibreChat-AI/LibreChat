import type { OpenIdClientAuthFactories } from './clientAuth';
import { resolveOpenIdClientAuth } from './clientAuth';

type FakeAuth = { kind: string; secret?: string };

const createFactories = (): jest.Mocked<OpenIdClientAuthFactories<FakeAuth>> => ({
  ClientSecretBasic: jest.fn((secret: string) => ({ kind: 'basic', secret })),
  ClientSecretPost: jest.fn((secret: string) => ({ kind: 'post', secret })),
  None: jest.fn(() => ({ kind: 'none' })),
});

describe('resolveOpenIdClientAuth', () => {
  let factories: jest.Mocked<OpenIdClientAuthFactories<FakeAuth>>;

  beforeEach(() => {
    factories = createFactories();
  });

  describe('without an explicit method', () => {
    it('leaves client authentication to the library for a secret-based client', () => {
      const result = resolveOpenIdClientAuth({
        clientSecret: 'secret',
        usePKCE: false,
        generateNonce: false,
        factories,
      });

      expect(result).toEqual({ ok: true, value: {} });
      expect(factories.ClientSecretPost).not.toHaveBeenCalled();
    });

    it('keeps client_secret_post metadata when nonce generation is enabled', () => {
      const result = resolveOpenIdClientAuth({
        clientSecret: 'secret',
        usePKCE: false,
        generateNonce: true,
        factories,
      });

      expect(result).toEqual({
        ok: true,
        value: { tokenEndpointAuthMethod: 'client_secret_post' },
      });
    });

    it('uses none metadata for a PKCE client without a secret', () => {
      const result = resolveOpenIdClientAuth({ usePKCE: true, generateNonce: false, factories });

      expect(result).toEqual({ ok: true, value: { tokenEndpointAuthMethod: 'none' } });
      expect(factories.None).not.toHaveBeenCalled();
    });

    it('treats a blank method as unset', () => {
      const result = resolveOpenIdClientAuth({
        method: '   ',
        clientSecret: 'secret',
        usePKCE: false,
        generateNonce: false,
        factories,
      });

      expect(result).toEqual({ ok: true, value: {} });
    });
  });

  describe('with an explicit method', () => {
    it('builds HTTP Basic client authentication for client_secret_basic', () => {
      const result = resolveOpenIdClientAuth({
        method: 'client_secret_basic',
        clientSecret: 'secret',
        usePKCE: false,
        generateNonce: true,
        factories,
      });

      expect(factories.ClientSecretBasic).toHaveBeenCalledWith('secret');
      expect(result).toEqual({
        ok: true,
        value: {
          tokenEndpointAuthMethod: 'client_secret_basic',
          clientAuthentication: { kind: 'basic', secret: 'secret' },
        },
      });
    });

    it('builds body client authentication for client_secret_post', () => {
      const result = resolveOpenIdClientAuth({
        method: 'client_secret_post',
        clientSecret: 'secret',
        usePKCE: false,
        generateNonce: false,
        factories,
      });

      expect(factories.ClientSecretPost).toHaveBeenCalledWith('secret');
      expect(result).toEqual({
        ok: true,
        value: {
          tokenEndpointAuthMethod: 'client_secret_post',
          clientAuthentication: { kind: 'post', secret: 'secret' },
        },
      });
    });

    it('builds no client authentication for none, even when a secret is set', () => {
      const result = resolveOpenIdClientAuth({
        method: 'none',
        clientSecret: 'secret',
        usePKCE: true,
        generateNonce: false,
        factories,
      });

      expect(factories.ClientSecretPost).not.toHaveBeenCalled();
      expect(result).toEqual({
        ok: true,
        value: { tokenEndpointAuthMethod: 'none', clientAuthentication: { kind: 'none' } },
      });
    });

    it('normalizes case and surrounding whitespace', () => {
      const result = resolveOpenIdClientAuth({
        method: '  Client_Secret_Basic ',
        clientSecret: 'secret',
        usePKCE: false,
        generateNonce: false,
        factories,
      });

      expect(result.ok && result.value.tokenEndpointAuthMethod).toBe('client_secret_basic');
    });

    it.each(['client_secret_basic', 'client_secret_post'])(
      'fails with a stable code when %s has no client secret',
      (method) => {
        const result = resolveOpenIdClientAuth({
          method,
          usePKCE: false,
          generateNonce: false,
          factories,
        });

        expect(result).toEqual({
          ok: false,
          error: expect.objectContaining({ code: 'OPENID_CLIENT_SECRET_REQUIRED' }),
        });
        expect(factories.ClientSecretBasic).not.toHaveBeenCalled();
        expect(factories.ClientSecretPost).not.toHaveBeenCalled();
      },
    );

    it('rejects an unsupported method without echoing it back', () => {
      const result = resolveOpenIdClientAuth({
        method: 'private_key_jwt',
        clientSecret: 'secret',
        usePKCE: false,
        generateNonce: false,
        factories,
      });

      expect(result).toEqual({
        ok: false,
        error: expect.objectContaining({ code: 'OPENID_INVALID_TOKEN_ENDPOINT_AUTH_METHOD' }),
      });
      expect(!result.ok && result.error.message).not.toContain('private_key_jwt');
    });
  });
});
