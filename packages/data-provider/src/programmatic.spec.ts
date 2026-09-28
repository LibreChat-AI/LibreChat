import { baseEndpointSchema, configSchema } from './config';

describe('programmatic tools configuration', () => {
  it('preserves the disabled default for existing configurations', () => {
    expect(baseEndpointSchema.parse({})).not.toHaveProperty('programmaticTools');
    expect(baseEndpointSchema.parse({ programmaticTools: {} })).toHaveProperty(
      'programmaticTools',
      {
        enabled: false,
        mcpServers: [],
      },
    );
  });

  it.each(['all', 'openAI', 'anthropic', 'bedrock'])(
    'retains the %s endpoint opt-in',
    (endpoint) => {
      const programmaticTools = { enabled: true, mcpServers: ['code-execution'] };
      const parsed = configSchema.parse({
        version: '1.2.1',
        endpoints: { [endpoint]: { programmaticTools } },
      });

      expect(parsed.endpoints).toHaveProperty(`${endpoint}.programmaticTools`, programmaticTools);
    },
  );

  it('retains custom endpoint configuration', () => {
    const programmaticTools = { enabled: true, mcpServers: ['code-execution'] };
    const parsed = configSchema.parse({
      version: '1.2.1',
      endpoints: {
        custom: [
          {
            name: 'Gateway',
            apiKey: '${GATEWAY_API_KEY}',
            baseURL: 'https://gateway.example/v1',
            models: { default: ['test-model'] },
            programmaticTools,
          },
        ],
      },
    });

    expect(parsed.endpoints?.custom?.[0]).toHaveProperty('programmaticTools', programmaticTools);
  });

  it('requires an explicit enable flag even when servers are configured', () => {
    expect(
      baseEndpointSchema.parse({ programmaticTools: { mcpServers: ['sandbox'] } }),
    ).toHaveProperty('programmaticTools', { enabled: false, mcpServers: ['sandbox'] });
  });

  it('defaults an enabled configuration to an empty server allowlist', () => {
    expect(baseEndpointSchema.parse({ programmaticTools: { enabled: true } })).toHaveProperty(
      'programmaticTools',
      { enabled: true, mcpServers: [] },
    );
  });

  it('trims explicit server names and preserves supported raw names', () => {
    expect(
      baseEndpointSchema.parse({
        programmaticTools: {
          mcpServers: [' sandbox ', 'My Code Server', 'Google_mcp_Workspace'],
        },
      }),
    ).toHaveProperty('programmaticTools.mcpServers', [
      'sandbox',
      'My Code Server',
      'Google_mcp_Workspace',
    ]);
  });

  it.each([
    null,
    true,
    { enabled: 'true' },
    { mcpServers: 'sandbox' },
    { mcpServers: [123] },
    { mcpServers: [''] },
    { mcpServers: ['   '] },
    { mcpServers: ['*'] },
    { mcpServers: [' * '] },
  ])('rejects invalid or unrestricted configuration: %j', (programmaticTools) => {
    expect(baseEndpointSchema.safeParse({ programmaticTools }).success).toBe(false);
  });
});
