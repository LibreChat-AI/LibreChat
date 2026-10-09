jest.mock(
  'librechat-data-provider',
  () => ({
    actionDelimiter: '_action_',
    normalizeActionToolName: (toolName: string) => toolName,
    validateAndParseOpenAPISpec: (specString: string) => {
      const spec = JSON.parse(specString) as { paths?: Record<string, unknown> };
      return {
        status: true,
        message: 'OpenAPI spec is valid.',
        spec,
        serverUrl: 'https://api.example.com',
      };
    },
  }),
  { virtual: true },
);

import { mergeAgentActionTools } from './tools';

const specFor = (operationId: string): string =>
  JSON.stringify({
    openapi: '3.0.0',
    info: { title: 'Action API', version: '1.0.0' },
    servers: [{ url: 'https://api.example.com' }],
    paths: {
      '/items': {
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

describe('mergeAgentActionTools', () => {
  it('preserves other action tools that share the previous domain', () => {
    const result = mergeAgentActionTools({
      existingTools: [
        'listItems_action_shared_domain',
        'echoMessage_action_shared_domain',
        'echoMessage_action_legacy_domain',
      ],
      incomingFunctions: [toolFor('echoMessage')],
      encodedDomain: 'new_domain',
      actionId: 'action-a',
      requestedActionId: 'action-a',
      previousEncodedDomain: 'shared_domain',
      previousLegacyDomain: 'legacy_domain',
      previousRawSpec: specFor('echoMessage'),
    });

    expect(result).toEqual(['listItems_action_shared_domain', 'echoMessage_action_new_domain']);
  });

  it('removes previous operation names when an action function is renamed', () => {
    const result = mergeAgentActionTools({
      existingTools: ['oldName_action_shared_domain', 'unrelated_action_shared_domain'],
      incomingFunctions: [toolFor('newName')],
      encodedDomain: 'shared_domain',
      actionId: 'action-a',
      requestedActionId: 'action-a',
      previousEncodedDomain: 'shared_domain',
      previousRawSpec: specFor('oldName'),
    });

    expect(result).toEqual(['unrelated_action_shared_domain', 'newName_action_shared_domain']);
  });

  it('removes legacy action-id keyed entries without dropping unrelated tools', () => {
    const result = mergeAgentActionTools({
      existingTools: [
        'legacy-action-a',
        'listItems_action_shared_domain',
        'echoMessage_action_shared_domain',
      ],
      incomingFunctions: [toolFor('echoMessage')],
      encodedDomain: 'shared_domain',
      actionId: 'action-a',
      requestedActionId: 'action-a',
      previousEncodedDomain: 'shared_domain',
      previousRawSpec: specFor('echoMessage'),
    });

    expect(result).toEqual(['listItems_action_shared_domain', 'echoMessage_action_shared_domain']);
  });
});
