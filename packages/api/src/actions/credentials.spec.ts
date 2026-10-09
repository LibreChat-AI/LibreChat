jest.mock(
  'librechat-data-provider',
  () => ({
    AuthTypeEnum: {
      ServiceHttp: 'service_http',
      OAuth: 'oauth',
      None: 'none',
    },
    AuthorizationTypeEnum: {
      Bearer: 'bearer',
    },
    TokenExchangeMethodEnum: {
      DefaultPost: 'default_post',
    },
    validateAndParseOpenAPISpec: (specString: string) => {
      const spec = JSON.parse(specString) as { servers?: Array<{ url?: string }> };
      return {
        status: true,
        spec,
        serverUrl: spec.servers?.[0]?.url,
      };
    },
  }),
  { virtual: true },
);

import {
  AuthTypeEnum,
  AuthorizationTypeEnum,
  TokenExchangeMethodEnum,
} from 'librechat-data-provider';
import type { ActionMetadata } from 'librechat-data-provider';
import { mergeActionMetadataForUpdate } from './credentials';

const specFor = (serverUrl: string): string =>
  JSON.stringify({
    openapi: '3.0.0',
    info: { title: 'Action API', version: '1.0.0' },
    servers: [{ url: serverUrl }],
    paths: {
      '/echo': {
        get: {
          operationId: 'echo',
          responses: { 200: { description: 'OK' } },
        },
      },
    },
  });

const serviceMetadata = (serverUrl = 'https://api.example.com/v1'): ActionMetadata => ({
  domain: 'https://api.example.com',
  raw_spec: specFor(serverUrl),
  api_key: 'encrypted-owner-key',
  auth: {
    type: AuthTypeEnum.ServiceHttp,
    authorization_type: AuthorizationTypeEnum.Bearer,
  },
});

describe('mergeActionMetadataForUpdate', () => {
  it('preserves existing service credentials when the action target is unchanged', () => {
    const incoming: ActionMetadata = {
      domain: 'https://api.example.com',
      raw_spec: specFor('https://api.example.com/v1'),
    };

    const result = mergeActionMetadataForUpdate({
      storedMetadata: serviceMetadata(),
      incomingMetadata: incoming,
    });

    expect(result.targetChanged).toBe(false);
    expect(result.requiresCredentialRefresh).toBe(false);
    expect(result.metadata.api_key).toBe('encrypted-owner-key');
  });

  it('requires a fresh service credential when the domain changes', () => {
    const incoming: ActionMetadata = {
      domain: 'https://attacker.example',
      raw_spec: specFor('https://attacker.example/v1'),
    };

    const result = mergeActionMetadataForUpdate({
      storedMetadata: serviceMetadata(),
      incomingMetadata: incoming,
    });

    expect(result.targetChanged).toBe(true);
    expect(result.requiresCredentialRefresh).toBe(true);
    expect(result.metadata.api_key).toBeUndefined();
  });

  it('treats OpenAPI server path changes as target changes', () => {
    const incoming: ActionMetadata = {
      domain: 'https://api.example.com',
      raw_spec: specFor('https://api.example.com/debug'),
    };

    const result = mergeActionMetadataForUpdate({
      storedMetadata: serviceMetadata(),
      incomingMetadata: incoming,
    });

    expect(result.targetChanged).toBe(true);
    expect(result.requiresCredentialRefresh).toBe(true);
    expect(result.metadata.api_key).toBeUndefined();
  });

  it('allows target changes when the request supplies a fresh service credential', () => {
    const incoming: ActionMetadata = {
      domain: 'https://api.example.com',
      raw_spec: specFor('https://api.example.com/v2'),
      api_key: 'encrypted-new-key',
      auth: {
        type: AuthTypeEnum.ServiceHttp,
        authorization_type: AuthorizationTypeEnum.Bearer,
      },
    };

    const result = mergeActionMetadataForUpdate({
      storedMetadata: serviceMetadata(),
      incomingMetadata: incoming,
    });

    expect(result.targetChanged).toBe(true);
    expect(result.requiresCredentialRefresh).toBe(false);
    expect(result.metadata.api_key).toBe('encrypted-new-key');
  });

  it('allows target changes when auth is explicitly removed', () => {
    const incoming: ActionMetadata = {
      domain: 'https://api.example.com',
      raw_spec: specFor('https://api.example.com/v2'),
      auth: {
        type: AuthTypeEnum.None,
      },
    };

    const result = mergeActionMetadataForUpdate({
      storedMetadata: serviceMetadata(),
      incomingMetadata: incoming,
    });

    expect(result.targetChanged).toBe(true);
    expect(result.requiresCredentialRefresh).toBe(false);
    expect(result.metadata.api_key).toBeUndefined();
  });

  it('requires fresh OAuth client credentials when OAuth endpoints change', () => {
    const storedMetadata: ActionMetadata = {
      domain: 'https://api.example.com',
      raw_spec: specFor('https://api.example.com/v1'),
      oauth_client_id: 'encrypted-client-id',
      oauth_client_secret: 'encrypted-client-secret',
      auth: {
        type: AuthTypeEnum.OAuth,
        authorization_url: 'https://auth.example.com/authorize',
        client_url: 'https://auth.example.com/token',
        scope: 'read',
        token_exchange_method: TokenExchangeMethodEnum.DefaultPost,
      },
    };
    const incomingMetadata: ActionMetadata = {
      auth: {
        type: AuthTypeEnum.OAuth,
        authorization_url: 'https://evil.example/authorize',
        client_url: 'https://evil.example/token',
        scope: 'read',
        token_exchange_method: TokenExchangeMethodEnum.DefaultPost,
      },
    };

    const result = mergeActionMetadataForUpdate({
      storedMetadata,
      incomingMetadata,
    });

    expect(result.targetChanged).toBe(true);
    expect(result.requiresCredentialRefresh).toBe(true);
    expect(result.metadata.oauth_client_id).toBeUndefined();
    expect(result.metadata.oauth_client_secret).toBeUndefined();
  });
});
