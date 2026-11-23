import { z } from 'zod';
import { tool } from '@langchain/core/tools';
import type { FiltersConfig } from 'librechat-data-provider';
import { assertModelBoundContent } from './modelBoundContent';

const opaque = 'data:application/pdf;base64,c2VjcmV0';
const filters: FiltersConfig = {
  files: {
    pii: {
      starterPatterns: [],
      fields: ['content', 'extracted_text'],
      uninspectable: 'block',
    },
  },
};
const file = {
  file_id: 'file-context',
  filename: 'context.txt',
  filepath: '/uploads/context.txt',
  text: 'Safe extracted context',
  type: 'text/plain',
  llmDeliveryPath: 'text',
};

function catalog() {
  return Array.from({ length: 67 }, (_, index) => ({
    name: `query_${index}`,
    description: 'Query a report',
    parameters: {
      type: 'object',
      properties: Object.fromEntries(
        Array.from({ length: 64 }, (_, field) => [
          `field_${field}`,
          { type: 'string', description: 'A report dimension', enum: ['one', 'two'] },
        ]),
      ),
    },
  }));
}

describe('agent tool catalogs at the file-inspection boundary', () => {
  it('does not turn audit-only schema exhaustion into a file-inspection block', () => {
    const audit = {
      action: 'audit' as const,
      starterPatterns: [],
      customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-[A-Z]+' }],
    };
    expect(() =>
      assertModelBoundContent({
        filters: {
          messages: { pii: audit },
          files: { pii: { ...audit, uninspectable: 'allow' } },
          toolArguments: { pii: audit },
          agentInstructions: { pii: audit },
        },
        agents: [
          {
            toolDefinitions: [
              { name: 'large', parameters: Array.from({ length: 4_200 }, () => ({})) },
            ],
            requestAttachments: [file],
          } as never,
        ],
      }),
    ).not.toThrow();
  });

  it('keeps blocking message and instruction policies active when opaque files are allowed', () => {
    const block = {
      starterPatterns: [],
      customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-[A-Z]+' }],
    };
    for (const policy of [
      {
        filters: { messages: { pii: block } },
        submittedMessages: [{ role: 'user', content: 'PRIVATE-MESSAGE' }],
      },
      {
        filters: { agentInstructions: { pii: block } },
        agents: [{ instructions: 'PRIVATE-INSTRUCTIONS', requestAttachments: [file] }],
      },
    ]) {
      expect(() => assertModelBoundContent(policy)).toThrow(
        'Submitted content contains a private value',
      );
    }
  });

  it.each([true, false])('inspects all tool definitions with a hydrated file: %s', (hydrated) => {
    const toolDefinitions = catalog();
    const agent = { toolDefinitions, requestAttachments: hydrated ? [file] : [] };
    expect(() => assertModelBoundContent({ filters, agents: [agent] })).not.toThrow();
    expect(agent.toolDefinitions).toBe(toolDefinitions);
    expect(agent.requestAttachments[0]).toBe(hydrated ? file : undefined);
  });

  it('admits a real initialized SDK tool catalog, not only JSON definitions', () => {
    const tools = Array.from({ length: 67 }, (_, index) =>
      tool(async () => 'result', {
        name: `query_${index}`,
        description: 'Query a report',
        schema: z.object({ dimension: z.string(), filter: z.string().optional() }),
      }),
    );
    expect(() =>
      assertModelBoundContent({
        filters,
        agents: [{ tools, toolDefinitions: catalog(), requestAttachments: [file] } as never],
      }),
    ).not.toThrow();
  });

  it.each([true, false])(
    'blocks opaque content in the final caller tool (hydrated: %s)',
    (hydrated) => {
      for (const payload of [
        { description: opaque },
        { parameters: { nested: { payload: opaque } } },
        { parameters: { nested: { type: 'input_file', file_id: 'unresolved' } } },
        { extra: { payload: opaque } },
      ]) {
        const toolDefinitions = catalog();
        const agent = { toolDefinitions, requestAttachments: hydrated ? [file] : [] };
        expect(() => assertModelBoundContent({ filters, agents: [agent] })).not.toThrow();
        Object.assign(toolDefinitions[66], payload);
        expect(() => assertModelBoundContent({ filters, agents: [agent] })).toThrow(
          'Submitted file content could not be inspected before processing.',
        );
      }
    },
  );

  it('preserves independent source-specific inspection of late tool descriptions', () => {
    const toolDefinitions = catalog();
    toolDefinitions[66].description = 'PRIVATE-LATE';
    expect(() =>
      assertModelBoundContent({
        filters: {
          ...filters,
          agentInstructions: {
            pii: {
              fields: ['description'],
              starterPatterns: [],
              customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-[A-Z]+' }],
            },
          },
        },
        agents: [{ toolDefinitions, requestAttachments: [file] } as never],
      }),
    ).toThrow('Submitted content contains a private value');
  });

  it('still fails closed when a single definition exceeds its structural budget', () => {
    const toolDefinitions = [
      { name: 'huge', parameters: Array.from({ length: 4_200 }, () => ({})) },
    ];
    expect(() =>
      assertModelBoundContent({
        filters,
        agents: [{ toolDefinitions, requestAttachments: [file] } as never],
      }),
    ).toThrow('Submitted content could not be completely inspected before processing.');
  });

  it('still bounds the number of tool entries', () => {
    const toolDefinitions = Array.from({ length: 4_200 }, () => ({ name: 'tool' }));
    expect(() => assertModelBoundContent({ filters, agents: [{ toolDefinitions }] })).toThrow(
      'Submitted content could not be completely inspected before processing.',
    );
  });

  it('inspects enumerable non-index properties on a tool array', () => {
    const toolDefinitions = Object.assign(catalog(), { payload: opaque });
    expect(() => assertModelBoundContent({ filters, agents: [{ toolDefinitions }] })).toThrow(
      'Submitted file content could not be inspected before processing.',
    );
  });

  it('inspects late executable-tool fields as well as toolDefinitions', () => {
    const tools = catalog();
    const agent = { tools, requestAttachments: [file] };
    expect(() => assertModelBoundContent({ filters, agents: [agent as never] })).not.toThrow();
    tools[66].description = opaque;
    expect(() => assertModelBoundContent({ filters, agents: [agent as never] })).toThrow(
      'Submitted file content could not be inspected before processing.',
    );
  });

  it.each([true, false])('bounds sparse catalogs before inspection (hydrated: %s)', (hydrated) => {
    const toolDefinitions = new Array<{ name: string }>(1_000_000);
    expect(() =>
      assertModelBoundContent({
        filters,
        agents: [{ toolDefinitions, requestAttachments: hydrated ? [file] : [] } as never],
      }),
    ).toThrow('Submitted content could not be completely inspected before processing.');
  });

  it('fails closed on a revoked catalog proxy without exposing its reflection error', () => {
    const { proxy, revoke } = Proxy.revocable([{ name: 'query' }], {});
    revoke();
    expect(() =>
      assertModelBoundContent({ filters, agents: [{ toolDefinitions: proxy }] }),
    ).toThrow('Submitted content could not be completely inspected before processing.');
  });

  it.each(['proxy', 'getter'])('fails closed on a catalog %s', (kind) => {
    const toolDefinitions = [{ name: 'query' }];
    const catalog = kind === 'proxy' ? new Proxy(toolDefinitions, {}) : toolDefinitions;
    if (kind === 'getter') {
      Object.defineProperty(catalog, '0', {
        enumerable: true,
        get: () => {
          throw new Error('blocked');
        },
      });
    }
    expect(() =>
      assertModelBoundContent({ filters, agents: [{ toolDefinitions: catalog }] }),
    ).toThrow('Submitted content could not be completely inspected before processing.');
  });
});
