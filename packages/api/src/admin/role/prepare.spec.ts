import { logger } from '@librechat/data-schemas';
import { prepareConfigOverrides } from './prepare';

describe('prepareConfigOverrides', () => {
  it('rejects process-backed MCP servers', () => {
    expect(() =>
      prepareConfigOverrides({
        mcpServers: { local: { command: 'node', args: ['server.js'] } },
      }),
    ).toThrow('Process-backed MCP servers');
  });

  it('strips sections that cannot be overridden by a role', () => {
    const warning = jest.spyOn(logger, 'warn').mockImplementation(() => logger);

    expect(prepareConfigOverrides({ filters: {} })).toEqual({});
    expect(prepareConfigOverrides({ langfuse: { publicKey: 'public' } })).toEqual({});
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('base-only config section'));
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('tenant-wide config section'));
  });

  it('strips interface permissions and preserves supported values', () => {
    expect(
      prepareConfigOverrides({
        interface: {
          mcpServers: { use: true, placeholder: 'Choose a server' },
          modelSelect: true,
        },
      }),
    ).toEqual({
      interface: {
        mcpServers: { placeholder: 'Choose a server' },
        modelSelect: true,
      },
    });
  });
});
