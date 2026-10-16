import { MCPServersRegistry } from '~/mcp/registry/MCPServersRegistry';
import { getMCPServerInstructions } from './instructions';

jest.mock('~/mcp/registry/MCPServersRegistry', () => ({
  MCPServersRegistry: { getInstance: jest.fn() },
}));

describe('getMCPServerInstructions', () => {
  const getAllServerConfigs = jest.fn();

  beforeEach(() => {
    getAllServerConfigs.mockReset().mockResolvedValue({
      files: { type: 'stdio', command: 'node', serverInstructions: 'Files rule' },
      github: { type: 'sse', url: 'https://example.invalid', serverInstructions: 'GitHub rule' },
      database: { type: 'sse', url: 'https://example.invalid' },
    });
    (MCPServersRegistry.getInstance as jest.Mock).mockReturnValue({ getAllServerConfigs });
  });

  it('returns the instructions of the named servers in name order, whatever order they come in', async () => {
    const first = await getMCPServerInstructions(['github', 'files', 'database']);
    const second = await getMCPServerInstructions(['database', 'files', 'github']);
    expect(Object.keys(first)).toEqual(['files', 'github']);
    expect(second).toEqual(first);
    expect(first).toEqual({ files: 'Files rule', github: 'GitHub rule' });
  });

  it('leaves out unknown servers and servers without instructions', async () => {
    expect(await getMCPServerInstructions(['database', 'missing'])).toEqual({});
  });

  it('passes the request-scoped configs to the registry', async () => {
    const configServers = { overlay: { type: 'sse', url: 'https://example.invalid' } } as never;
    await getMCPServerInstructions(['files'], configServers);
    expect(getAllServerConfigs).toHaveBeenCalledWith(undefined, configServers);
  });
});
