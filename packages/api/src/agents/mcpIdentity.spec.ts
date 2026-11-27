import type { PersistedMcpContentPart } from './mcpIdentity';
import { stampMcpServerIdentities } from './mcpIdentity';

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
