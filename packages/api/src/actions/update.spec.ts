jest.mock(
  'librechat-data-provider',
  () => ({
    actionDelimiter: '_action_',
    actionDomainSeparator: '---',
    Constants: {
      ENCODED_DOMAIN_LENGTH: 64,
    },
    AuthTypeEnum: {
      ServiceHttp: 'service_http',
      OAuth: 'oauth',
      None: 'none',
    },
    AuthorizationTypeEnum: {
      Bearer: 'bearer',
    },
    validateAndParseOpenAPISpec: (specString: string) => {
      const spec = JSON.parse(specString) as { servers?: Array<{ url?: string }> };
      return {
        status: true,
        message: 'OpenAPI spec is valid.',
        spec,
        serverUrl: spec.servers?.[0]?.url,
      };
    },
  }),
  { virtual: true },
);

import { AuthTypeEnum, AuthorizationTypeEnum } from 'librechat-data-provider';
import type { ActionMetadata } from 'librechat-data-provider';
import {
  buildActionOAuthTokenDeleteQueries,
  legacyActionDomainEncode,
  planAgentActionUpdate,
} from './update';

const specFor = (serverUrl: string, operationId = 'echoMessage'): string =>
  JSON.stringify({
    openapi: '3.0.0',
    info: { title: 'Action API', version: '1.0.0' },
    servers: [{ url: serverUrl }],
    paths: {
      '/echo': {
        get: {
          operationId,
          responses: { 200: { description: 'OK' } },
        },
      },
    },
  });

const toolFor = (name: string) => ({
  function: {
    name,
  },
});

const storedServiceMetadata: ActionMetadata = {
  domain: 'https://api.example.com',
  raw_spec: specFor('https://api.example.com/v1'),
  api_key: 'encrypted-owner-key',
  auth: {
    type: AuthTypeEnum.ServiceHttp,
    authorization_type: AuthorizationTypeEnum.Bearer,
  },
};

describe('planAgentActionUpdate', () => {
  it('requires refreshed credentials when an existing target changes without new credentials', () => {
    const result = planAgentActionUpdate({
      agentActions: ['api---example---com_action_action-1'],
      agentTools: ['echoMessage_action_api---example---com'],
      incomingFunctions: [toolFor('echoMessage')],
      incomingMetadata: {
        domain: 'https://other.example.com',
        raw_spec: specFor('https://other.example.com/v1'),
      },
      actionId: 'action-1',
      requestedActionId: 'action-1',
      encodedDomain: 'other---example---com',
      legacyDomain: legacyActionDomainEncode('https://other.example.com'),
      previousLegacyDomain: legacyActionDomainEncode('https://api.example.com'),
      storedAction: {
        metadata: storedServiceMetadata,
      },
    });

    expect(result.requiresCredentialRefresh).toBe(true);
    expect(result.targetChanged).toBe(true);
    expect(result.deleteOAuthTokens).toBe(true);
    expect(result.metadata.api_key).toBeUndefined();
  });

  it('plans a stable-id target update while preserving unrelated same-domain tools', () => {
    const result = planAgentActionUpdate({
      agentActions: ['api---example---com_action_action-1', 'api---example---com_action_action-2'],
      agentTools: [
        'echoMessage_action_api---example---com',
        'listItems_action_api---example---com',
      ],
      incomingFunctions: [toolFor('echoMessage')],
      incomingMetadata: {
        domain: 'https://other.example.com',
        raw_spec: specFor('https://other.example.com/v1'),
        api_key: 'encrypted-new-key',
        auth: {
          type: AuthTypeEnum.ServiceHttp,
          authorization_type: AuthorizationTypeEnum.Bearer,
        },
      },
      actionId: 'action-1',
      requestedActionId: 'action-1',
      encodedDomain: 'other---example---com',
      legacyDomain: legacyActionDomainEncode('https://other.example.com'),
      previousLegacyDomain: legacyActionDomainEncode('https://api.example.com'),
      storedAction: {
        metadata: storedServiceMetadata,
      },
    });

    expect(result.requiresCredentialRefresh).toBe(false);
    expect(result.actionId).toBe('action-1');
    expect(result.deleteOAuthTokens).toBe(true);
    expect(result.actions).toEqual([
      'api---example---com_action_action-2',
      'other---example---com_action_action-1',
    ]);
    expect(result.tools).toEqual([
      'listItems_action_api---example---com',
      'echoMessage_action_other---example---com',
    ]);
  });
});

describe('buildActionOAuthTokenDeleteQueries', () => {
  it('builds escaped access and refresh token identifier queries', () => {
    const [accessQuery, refreshQuery] = buildActionOAuthTokenDeleteQueries('action.1');

    expect(accessQuery).toEqual({
      type: 'oauth',
      identifier: expect.any(RegExp),
    });
    expect(refreshQuery).toEqual({
      type: 'oauth_refresh',
      identifier: expect.any(RegExp),
    });
    expect(accessQuery.identifier.test('user-1:action.1')).toBe(true);
    expect(accessQuery.identifier.test('user-1:actionx1')).toBe(false);
    expect(refreshQuery.identifier.test('user-1:action.1:refresh')).toBe(true);
  });
});
