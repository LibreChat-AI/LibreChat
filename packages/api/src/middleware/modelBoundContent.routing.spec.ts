import { RE2JS } from 're2js';
import { logger } from '@librechat/data-schemas';
import {
  FileSources,
  EImageOutputType,
  mergeFileConfig,
  setFileConfigRegexCompiler,
} from 'librechat-data-provider';
import type { FiltersConfig } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import { resolveTurnDeliveryRouting } from '../agents/files/delivery';
import { configureFileConfigRegexEngine } from '../files/regexEngine';
import { filterFilesByEndpointRuntimeConfig } from '../files/filter';
import { assertModelBoundContent } from './modelBoundContent';

const officeMime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const pattern = { id: 'private', label: 'private value', regex: 'PRIVATE-[A-Z]+' };
const pii = { starterPatterns: [], customPatterns: [pattern] };
const strictFiles: FiltersConfig = {
  files: { pii: { ...pii, fields: ['content', 'extracted_text'], uninspectable: 'block' } },
};
const opaque = 'data:application/pdf;base64,c2VjcmV0';

function setup() {
  const config: AppConfig = {
    config: {},
    fileStrategy: FileSources.local,
    imageOutputType: EImageOutputType.PNG,
    fileConfig: {
      endpoints: {
        agents: {
          supportedMimeTypes: ['text/plain', officeMime],
          defaultLLMDeliveryPath: { fallback: 'text' as const },
        },
      },
    },
  };
  const deliveryRouting = resolveTurnDeliveryRouting({
    agent: { provider: 'openAI', endpoint: 'agents' },
    config,
  });
  const hydrate = (type: string) => {
    const files = [
      {
        file_id: 'file-context',
        filename: type === officeMime ? 'context.docx' : 'context.txt',
        filepath: '/uploads/context',
        type,
        bytes: 32,
        text: 'Safe extracted document text',
        content: 'Safe extracted document text',
        llmDeliveryPath: 'text' as const,
      },
    ];
    return filterFilesByEndpointRuntimeConfig(config, { files, endpoint: 'agents' });
  };
  return { config, deliveryRouting, hydrate };
}

beforeEach(() => configureFileConfigRegexEngine());
afterEach(() => setFileConfigRegexCompiler((value) => new RegExp(value)));

describe('runtime MIME metadata at the model-bound boundary', () => {
  it.each([
    ['message policy', { filters: { messages: { pii } } }],
    ['legacy policy', { legacyPii: pii }],
    ['strict file policy', { filters: strictFiles }],
    ['schema policy', { filters: { toolArguments: { pii } } }],
    ['mixed policy', { filters: { ...strictFiles, messages: { pii } } }],
  ] as const)('admits TXT, DOCX and post-Office TXT under %s', (_name, policy) => {
    const { config, deliveryRouting, hydrate } = setup();
    expect(deliveryRouting.endpointConfig.supportedMimeTypes?.[1]).toBeInstanceOf(RE2JS);
    expect(deliveryRouting.fileConfig).toBe(mergeFileConfig(config.fileConfig));
    for (const type of ['text/plain', officeMime, 'text/plain']) {
      const requestAttachments = hydrate(type);
      expect(requestAttachments).toHaveLength(1);
      expect(() =>
        assertModelBoundContent({
          ...policy,
          agents: [{ deliveryRouting, requestAttachments } as never],
        }),
      ).not.toThrow();
      expect(requestAttachments[0].filepath).toBe('/uploads/context');
      expect(deliveryRouting.fileConfig).toBe(mergeFileConfig(config.fileConfig));
    }
    // A new config object models the unexpanded state of a fresh server process.
    const fresh = setup();
    expect(() =>
      assertModelBoundContent({
        ...policy,
        agents: [
          {
            deliveryRouting: fresh.deliveryRouting,
            requestAttachments: fresh.hydrate('text/plain'),
          } as never,
        ],
      }),
    ).not.toThrow();
  });

  it.each([
    { messages: { pii } },
    { files: { pii: { fields: ['name'], starterPatterns: [], uninspectable: 'block' } } },
  ] satisfies FiltersConfig[])(
    'preserves attachment-free admission without selected opaque-file content: %j',
    (filters) => {
      const { deliveryRouting } = setup();
      const read = jest.fn(() => {
        throw new Error('unselected runtime field');
      });
      const agent = { name: 'Office agent', deliveryRouting };
      Object.defineProperty(agent, 'runtimeOnly', { enumerable: true, get: read });
      expect(() => assertModelBoundContent({ filters, agents: [agent] })).not.toThrow();
    },
  );

  it('admits fresh-process TXT before any Office match', () => {
    const { deliveryRouting, hydrate } = setup();
    expect(() =>
      assertModelBoundContent({
        filters: { messages: { pii } },
        agents: [{ deliveryRouting, requestAttachments: hydrate('text/plain') } as never],
      }),
    ).not.toThrow();
  });

  it('does not poison subsequent TXT after the cached matcher sees Office', () => {
    const { deliveryRouting, hydrate } = setup();
    hydrate(officeMime);
    expect(() =>
      assertModelBoundContent({
        filters: { messages: { pii } },
        agents: [{ deliveryRouting, requestAttachments: hydrate('text/plain') } as never],
      }),
    ).not.toThrow();
  });

  it.each([true, false])(
    'never reflects into compiled runtime matchers (hydrated: %s)',
    (hydrated) => {
      const { deliveryRouting, hydrate } = setup();
      const requestAttachments = hydrate(officeMime);
      const read = jest.fn(() => {
        throw new Error('runtime matcher must not be inspected');
      });
      Object.defineProperty(
        deliveryRouting.endpointConfig.supportedMimeTypes?.[1],
        'inspectionProbe',
        { enumerable: true, get: read },
      );
      expect(() =>
        assertModelBoundContent({
          filters: strictFiles,
          agents: [
            { deliveryRouting, requestAttachments: hydrated ? requestAttachments : [] } as never,
          ],
        }),
      ).not.toThrow();
      expect(read).not.toHaveBeenCalled();
    },
  );

  it.each([[[]], [[{ filename: 'context.txt', text: 'Safe extracted text' }]]])(
    'projects runtime metadata even with no usable hydrated file IDs: %j',
    (requestAttachments) => {
      const { deliveryRouting, hydrate } = setup();
      hydrate(officeMime);
      expect(() =>
        assertModelBoundContent({
          filters: strictFiles,
          agents: [{ deliveryRouting, requestAttachments } as never],
        }),
      ).not.toThrow();
    },
  );

  it.each([
    { instructions: opaque },
    { model_parameters: { additionalModelRequestFields: { file_data: opaque } } },
    { toolDefinitions: [{ name: 'caller', description: opaque }] },
    { toolDefinitions: [{ name: 'caller', parameters: { nested: { payload: opaque } } }] },
    {
      toolDefinitions: [
        { name: 'caller', parameters: { nested: { type: 'input_file', file_id: 'unresolved' } } },
      ],
    },
    { tool_resources: { context: { file_ids: ['unresolved'] } } },
  ])('keeps provider-bound fields in strict opaque-file inspection: %j', (fields) => {
    const { deliveryRouting, hydrate } = setup();
    expect(() =>
      assertModelBoundContent({
        filters: strictFiles,
        agents: [{ deliveryRouting, requestAttachments: hydrate(officeMime), ...fields } as never],
      }),
    ).toThrow('Submitted file content could not be inspected');
  });

  it.each([
    (route: object) => ({ ...route, opaque }),
    () => ({ endpointConfig: { supportedMimeTypes: [opaque] } }),
  ])('does not trust a caller-supplied deliveryRouting lookalike %#', (makeRoute) => {
    const { deliveryRouting, hydrate } = setup();
    expect(() =>
      assertModelBoundContent({
        filters: strictFiles,
        agents: [
          {
            deliveryRouting: makeRoute(deliveryRouting),
            requestAttachments: hydrate('text/plain'),
          } as never,
        ],
      }),
    ).toThrow('Submitted file content could not be inspected');
  });

  it('does not omit a nested caller field named deliveryRouting', () => {
    const { deliveryRouting, hydrate } = setup();
    expect(() =>
      assertModelBoundContent({
        filters: strictFiles,
        agents: [
          {
            deliveryRouting,
            requestAttachments: hydrate(officeMime),
            model_parameters: { additionalModelRequestFields: { deliveryRouting: { opaque } } },
          } as never,
        ],
      }),
    ).toThrow('Submitted file content could not be inspected');
  });

  it('checks newly merged Responses caller tools after an initially safe agent check', () => {
    const { deliveryRouting, hydrate } = setup();
    const agent = {
      deliveryRouting,
      requestAttachments: hydrate('text/plain'),
      toolDefinitions: [{ name: 'safe' }],
    };
    assertModelBoundContent({ filters: strictFiles, agents: [agent as never] });
    // Responses merges request.tools after its first agent check, then checks this same object.
    Object.assign(agent, {
      toolDefinitions: [
        ...agent.toolDefinitions,
        { name: 'caller', parameters: { payload: opaque } },
      ],
    });
    expect(() =>
      assertModelBoundContent({ filters: strictFiles, agents: [agent as never] }),
    ).toThrow('Submitted file content could not be inspected');
  });

  it.each([
    ['agentInstructions', { instructions: 'PRIVATE-INSTRUCTIONS' }],
    [
      'modelParameters',
      { model_parameters: { additionalModelRequestFields: { value: 'PRIVATE-PARAMETER' } } },
    ],
    [
      'toolArguments',
      { toolDefinitions: [{ name: 'caller', parameters: { description: 'PRIVATE-SCHEMA' } }] },
    ],
  ] as const)('preserves selected %s content inspection', (source, fields) => {
    const { deliveryRouting, hydrate } = setup();
    expect(() =>
      assertModelBoundContent({
        filters: { [source]: { pii } },
        agents: [{ deliveryRouting, requestAttachments: hydrate(officeMime), ...fields } as never],
      }),
    ).toThrow('Submitted content contains a private value');
  });

  it('still inspects actual extracted bytes and records file audits with a blocking rule', () => {
    const info = jest.spyOn(logger, 'info').mockImplementation(() => logger);
    const { deliveryRouting, hydrate } = setup();
    const requestAttachments = hydrate(officeMime).map((file) => ({
      ...file,
      text: 'PRIVATE-FILE',
    }));
    expect(() =>
      assertModelBoundContent({
        filters: {
          ...strictFiles,
          files: { pii: { ...strictFiles.files?.pii, action: 'audit' } },
          agentInstructions: { pii },
        },
        agents: [
          { deliveryRouting, requestAttachments, instructions: 'PRIVATE-INSTRUCTIONS' } as never,
        ],
      }),
    ).toThrow('Submitted content contains a private value');
    expect(info).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ source: 'file', action: 'audit' }),
    );
  });

  it('fails closed on reflection failures outside trusted runtime metadata', () => {
    const { deliveryRouting, hydrate } = setup();
    const agent = { deliveryRouting, requestAttachments: hydrate(officeMime) };
    Object.defineProperty(agent, 'caller', {
      enumerable: true,
      get() {
        throw new Error('unreadable');
      },
    });
    expect(() =>
      assertModelBoundContent({ filters: strictFiles, agents: [agent as never] }),
    ).toThrow('Submitted content could not be completely inspected');
  });
});
