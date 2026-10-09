import { resolveMCPServerContext } from '../context';

describe('resolveMCPServerContext', () => {
  it('returns every configured name, not just the lazily-initialized ones', async () => {
    /** `ensureConfigServers` skips unmodified YAML servers, so its keys are not the
     *  configured set; boundary resolution needs the full list or it goes inert. */
    const ensureConfigServers = jest.fn().mockResolvedValue({ lazyInit: { name: 'lazyInit' } });

    const result = await resolveMCPServerContext({
      mcpConfig: { lazyInit: {}, unchangedYaml: {} } as never,
      ensureConfigServers,
    });

    expect(result.configServers).toEqual({ lazyInit: { name: 'lazyInit' } });
    expect(result.serverNames.sort()).toEqual(['lazyInit', 'unchangedYaml']);
    expect(ensureConfigServers).toHaveBeenCalledTimes(1);
  });

  it('normalizes names into the form tool keys embed', async () => {
    const result = await resolveMCPServerContext({
      mcpConfig: { 'Google MCP Workspace': {} } as never,
      ensureConfigServers: jest.fn().mockResolvedValue({}),
    });

    expect(result.serverNames).toEqual(['Google_MCP_Workspace']);
  });
});
