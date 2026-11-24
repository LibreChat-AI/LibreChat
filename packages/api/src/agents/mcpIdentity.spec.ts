import type { PersistedMcpContentPart } from './mcpIdentity';
import {
  createMcpServerNameResolver,
  stampLiveMcpToolCallIdentities,
  stampMcpServerIdentities,
  stampMcpServerIdentitiesOnMessages,
} from './mcpIdentity';

describe('stampMcpServerIdentities', () => {
  it('preserves exact nested execution identity over an ambiguous parsed boundary', () => {
    const contentParts = [
      {
        tool_call: {
          name: 'subagent',
          subagent_content: [
            {
              tool_call: {
                name: 'lookup_mcp_foo_mcp_bar',
                mcpServerName: 'bar',
              },
            },
          ],
        },
      },
    ];

    stampMcpServerIdentities({
      contentParts,
      roots: [{ accessibleMcpServerNames: ['bar', 'foo_mcp_bar'] }],
    });

    expect(contentParts[0].tool_call.subagent_content?.[0].tool_call.mcpServerName).toBe('bar');
  });

  it('uses resolved tool definitions before parsing a legacy tool key', () => {
    const contentParts: PersistedMcpContentPart[] = [
      { tool_call: { name: 'gitlab-get_mcp_server_version_mcp_bar' } },
    ];

    stampMcpServerIdentities({
      contentParts,
      roots: [
        {
          accessibleMcpServerNames: ['bar', 'version_mcp_bar'],
          toolDefinitions: [
            {
              name: 'gitlab-get_mcp_server_version_mcp_bar',
              serverName: 'bar',
            },
          ],
        },
      ],
    });

    expect(contentParts[0]?.tool_call?.mcpServerName).toBe('bar');
  });
});

describe('stampMcpServerIdentitiesOnMessages', () => {
  it('stamps OpenAI-shaped tool_calls and content-part calls from definitions', () => {
    const messages = [
      {
        tool_calls: [{ name: 'gitlab-get_mcp_server_version_mcp_bar' }],
      },
      {
        content: [{ tool_call: { name: 'run_query_mcp_bar' } }],
      },
      {
        additional_kwargs: {
          tool_calls: [{ function: { name: 'legacy_mcp_Connector__Company' } }],
        },
      },
    ];

    stampMcpServerIdentitiesOnMessages({
      messages,
      roots: [
        {
          accessibleMcpServerNames: ['bar', 'version_mcp_bar', 'Connector: Company'],
          toolDefinitions: [
            {
              name: 'gitlab-get_mcp_server_version_mcp_bar',
              serverName: 'bar',
            },
            {
              name: 'run_query_mcp_bar',
              serverName: 'bar',
            },
            {
              name: 'legacy_mcp_Connector__Company',
              serverName: 'Connector: Company',
            },
          ],
        },
      ],
    });

    expect(messages[0].tool_calls[0]).toEqual(
      expect.objectContaining({
        name: 'gitlab-get_mcp_server_version_mcp_bar',
        mcpServerName: 'bar',
      }),
    );
    expect(messages[1].content[0].tool_call.mcpServerName).toBe('bar');
    expect(messages[2].additional_kwargs.tool_calls[0]).toEqual(
      expect.objectContaining({
        name: 'legacy_mcp_Connector__Company',
        mcpServerName: 'Connector__Company',
      }),
    );
  });
});

describe('createMcpServerNameResolver', () => {
  it('prefers toolRegistry raw names then mcpAvailableTools', () => {
    const resolve = createMcpServerNameResolver(
      new Map([
        [
          'agent-a',
          {
            toolRegistry: {
              get: (name: string) =>
                name === 'lookup_mcp_bar' ? { mcpRawServerName: 'bar' } : undefined,
            },
            mcpAvailableTools: {
              'Connector: Company': {
                search_mcp_Connector__Company: { function: {} },
              },
            },
          },
        ],
      ]),
    );

    expect(resolve('lookup_mcp_bar', 'agent-a')).toBe('bar');
    expect(resolve('search_mcp_Connector__Company', 'agent-a')).toBe('Connector__Company');
    expect(resolve('lookup_mcp_bar', 'missing')).toBeUndefined();
  });
});

describe('stampLiveMcpToolCallIdentities', () => {
  it('stamps function-shaped run-step tool calls from the resolver', () => {
    const resolve = jest.fn(() => 'server');
    const toolCalls = [
      {
        id: 'call-1',
        function: { name: 'lookup_mcp_server', arguments: '{}' },
      },
    ];

    stampLiveMcpToolCallIdentities(toolCalls, resolve, 'lazy-agent');

    expect(resolve).toHaveBeenCalledWith('lookup_mcp_server', 'lazy-agent');
    expect(toolCalls[0]).toEqual(
      expect.objectContaining({ name: 'lookup_mcp_server', mcpServerName: 'server' }),
    );
  });
});
