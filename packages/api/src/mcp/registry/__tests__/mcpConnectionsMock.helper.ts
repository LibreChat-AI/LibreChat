import type { MCPConnection } from '~/mcp/connection';

/**
 * Creates a single mock MCP connection for testing.
 * The connection has a client with mocked methods that return server-specific data.
 * @param serverName - Name of the server to create mock connection for
 * @returns Mocked MCPConnection instance
 */
export function createMockConnection(serverName: string): jest.Mocked<MCPConnection> {
  const tools = [
    {
      name: 'listFiles',
      description: `Description for ${serverName}'s listFiles tool`,
      inputSchema: {
        type: 'object',
        properties: {
          input: { type: 'string' },
        },
      },
    },
  ];
  const mockClient = {
    getInstructions: jest.fn().mockReturnValue(`instructions for ${serverName}`),
    getServerCapabilities: jest.fn().mockReturnValue({
      tools: { listChanged: true },
      resources: { listChanged: true },
      prompts: { get: `getPrompts for ${serverName}` },
    }),
    listTools: jest.fn().mockResolvedValue({ tools }),
  };

  return {
    client: mockClient,
    fetchTools: jest.fn().mockResolvedValue(tools),
    fetchToolsSnapshot: jest.fn().mockResolvedValue({ tools, complete: true }),
    fetchOrderedToolsSnapshot: jest.fn().mockResolvedValue({ tools, complete: true }),
    disconnect: jest.fn().mockResolvedValue(undefined),
    dispose: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<MCPConnection>;
}

/**
 * Creates mock MCP connections for testing.
 * Each connection has a client with mocked methods that return server-specific data.
 * @param serverNames - Array of server names to create mock connections for
 * @returns Map of server names to mocked MCPConnection instances
 */
export function createMockConnectionsMap(
  serverNames: string[],
): Map<string, jest.Mocked<MCPConnection>> {
  const mockConnections = new Map<string, jest.Mocked<MCPConnection>>();

  serverNames.forEach((serverName) => {
    mockConnections.set(serverName, createMockConnection(serverName));
  });

  return mockConnections;
}
