import { MCPServersRegistry } from '~/mcp/registry/MCPServersRegistry';
import { getHiddenMCPServerNames, getMCPServerInstructions } from './instructions';

jest.mock('~/mcp/registry/MCPServersRegistry', () => ({
  MCPServersRegistry: { getInstance: jest.fn() },
}));

describe('getMCPServerInstructions', () => {
  const getAllServerConfigs = jest.fn();
  const getUserHiddenServerNames = jest.fn();

  beforeEach(() => {
    getAllServerConfigs.mockReset().mockResolvedValue({
      files: { type: 'stdio', command: 'node', serverInstructions: 'Files rule' },
      github: { type: 'sse', url: 'https://example.invalid', serverInstructions: 'GitHub rule' },
      database: { type: 'sse', url: 'https://example.invalid' },
    });
    getUserHiddenServerNames.mockReset().mockResolvedValue(new Set());
    (MCPServersRegistry.getInstance as jest.Mock).mockReturnValue({
      getAllServerConfigs,
      getUserHiddenServerNames,
    });
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

  it('leaves out the servers hidden from the acting user', async () => {
    getUserHiddenServerNames.mockResolvedValue(new Set(['github']));
    const user = { id: 'u1', role: 'USER' };
    expect(await getMCPServerInstructions(['files', 'github'], undefined, user)).toEqual({
      files: 'Files rule',
    });
    expect(getUserHiddenServerNames).toHaveBeenCalledWith(user);
  });
});

describe('getHiddenMCPServerNames', () => {
  const getInstance = MCPServersRegistry.getInstance as jest.Mock;

  it('reads the servers hidden from the acting user', async () => {
    const getUserHiddenServerNames = jest.fn().mockResolvedValue(new Set(['github']));
    getInstance.mockReturnValue({ getUserHiddenServerNames });
    const user = { id: 'u1', role: 'USER' };
    expect(await getHiddenMCPServerNames(user)).toEqual(new Set(['github']));
    expect(getUserHiddenServerNames).toHaveBeenCalledWith(user);
  });

  it('lets a failed read propagate instead of treating every server as visible', async () => {
    getInstance.mockReturnValue({
      getUserHiddenServerNames: jest.fn().mockRejectedValue(new Error('config unreadable')),
    });
    await expect(getHiddenMCPServerNames({ id: 'u1' })).rejects.toThrow('config unreadable');
  });

  it('hides nothing in a process without an MCP registry', async () => {
    getInstance.mockImplementation(() => {
      throw new Error('MCPServersRegistry has not been initialized.');
    });
    expect(await getHiddenMCPServerNames({ id: 'u1' })).toEqual(new Set());
  });
});
