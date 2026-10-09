import type { ParsedServerConfig } from '~/mcp/types';
import { resolveMCPReinitializeConfig } from './reinitialize';

describe('resolveMCPReinitializeConfig', () => {
  const stub: ParsedServerConfig = {
    type: 'streamable-http',
    url: 'https://recovering.example.com/mcp',
    source: 'yaml',
    inspectionFailed: true,
  };

  it('passes a config that did not fail inspection through without recovering it', async () => {
    const recoverServerConfig = jest.fn();
    const healthy: ParsedServerConfig = { ...stub, inspectionFailed: undefined };

    await expect(
      resolveMCPReinitializeConfig({ recoverServerConfig }, 'recovering', healthy, 'user-1'),
    ).resolves.toEqual({ serverConfig: healthy });
    await expect(
      resolveMCPReinitializeConfig({ recoverServerConfig }, 'recovering', undefined, 'user-1'),
    ).resolves.toEqual({ serverConfig: undefined });
    expect(recoverServerConfig).not.toHaveBeenCalled();
  });

  it('continues with the recovered config instead of the stub', async () => {
    const recovered: ParsedServerConfig = { ...stub, inspectionFailed: undefined, tools: 'echo' };
    const recoverServerConfig = jest.fn().mockResolvedValue(recovered);

    await expect(
      resolveMCPReinitializeConfig({ recoverServerConfig }, 'recovering', stub, 'user-1'),
    ).resolves.toEqual({ serverConfig: recovered });
    expect(recoverServerConfig).toHaveBeenCalledWith('recovering', stub, 'user-1');
  });

  it('stops with an unreachable result while the server cannot be recovered', async () => {
    const recoverServerConfig = jest.fn().mockResolvedValue(undefined);

    await expect(
      resolveMCPReinitializeConfig({ recoverServerConfig }, 'recovering', stub, 'user-1'),
    ).resolves.toEqual({
      result: {
        availableTools: null,
        success: false,
        message: "MCP server 'recovering' is still unreachable",
        failureReason: 'unreachable',
        oauthRequired: false,
        serverName: 'recovering',
        oauthUrl: null,
        tools: null,
      },
    });
  });
});
