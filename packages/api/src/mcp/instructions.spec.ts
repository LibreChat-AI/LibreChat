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

  it('lets a failed read propagate instead of treating every server as visible', async () => {
    getInstance.mockReturnValue({
      getUserHiddenServerNames: jest.fn().mockRejectedValue(new Error('config unreadable')),
    });
    await expect(getHiddenMCPServerNames({ id: 'u1' })).rejects.toThrow('config unreadable');
  });
});
