import { Constants, normalizeServerName } from 'librechat-data-provider';
import type { AgentToolOptions } from 'librechat-data-provider';
import type { LCAvailableTools, LCFunctionTool, ParsedServerConfig } from '~/mcp/types';
import { createMCPOAuthDeferral, shouldDeferMCPOAuthSignIn } from './defer';

const key = (tool: string, server: string) => `${tool}${Constants.mcp_delimiter}${server}`;

const onUseConfig: ParsedServerConfig = {
  type: 'streamable-http',
  url: 'https://sheets.example.com/mcp',
  source: 'yaml',
  requiresOAuth: true,
  oauthPrompt: 'on_use',
  oauthToolCatalog: [
    { name: 'read', description: 'Read a sheet' },
    { name: 'write', description: 'Write a sheet' },
  ],
};

const sheetsTools = [key('read', 'sheets'), key('write', 'sheets')];
const deferredOptions: AgentToolOptions = {
  [key('read', 'sheets')]: { defer_loading: true },
  [key('write', 'sheets')]: { defer_loading: true },
};

const decide = (overrides: Partial<Parameters<typeof shouldDeferMCPOAuthSignIn>[0]> = {}) =>
  shouldDeferMCPOAuthSignIn({
    serverName: 'sheets',
    serverConfig: onUseConfig,
    tools: [...sheetsTools, key('list', 'drive')],
    toolOptions: deferredOptions,
    deferredToolsEnabled: true,
    knownServerNames: ['sheets', 'drive'],
    ...overrides,
  });

describe('shouldDeferMCPOAuthSignIn', () => {
  it('defers a server whose selected tools are all deferred', () => {
    expect(decide()).toBe(true);
  });

  it('ignores server pins and tools from other servers', () => {
    expect(
      decide({ tools: [...sheetsTools, key(Constants.mcp_server, 'sheets'), key('x', 'drive')] }),
    ).toBe(true);
  });

  it('keeps the turn-start prompt when any selected tool loads up front', () => {
    expect(decide({ toolOptions: { ...deferredOptions, [key('write', 'sheets')]: {} } })).toBe(
      false,
    );
  });

  it('keeps the turn-start prompt for a whole-server selection', () => {
    expect(decide({ tools: [key(Constants.mcp_all, 'sheets')] })).toBe(false);
  });

  it('keeps the turn-start prompt when only a pin attaches the server', () => {
    expect(decide({ tools: [key(Constants.mcp_server, 'sheets')] })).toBe(false);
  });

  it('keeps the turn-start prompt when deferred tools are disabled', () => {
    expect(decide({ deferredToolsEnabled: false })).toBe(false);
  });

  it('keeps the turn-start prompt unless the server opts in', () => {
    expect(decide({ serverConfig: { ...onUseConfig, oauthPrompt: undefined } })).toBe(false);
    expect(decide({ serverConfig: { ...onUseConfig, oauthPrompt: 'on_start' } })).toBe(false);
  });

  it('matches tools keyed by a normalized server name', () => {
    const serverName = 'Connector: Company';
    const tool = key('read', normalizeServerName(serverName));
    expect(
      decide({
        serverName,
        tools: [tool],
        toolOptions: { [tool]: { defer_loading: true } },
        knownServerNames: [serverName],
      }),
    ).toBe(true);
  });

  it('keeps the turn-start prompt when the offered catalog misses a selected tool', () => {
    const catalog = { [key('read', 'sheets')]: {} } as LCAvailableTools;
    expect(decide({ catalog })).toBe(false);
  });

  it('keeps the turn-start prompt when a selected tool may run in the background', () => {
    const toolOptions = {
      ...deferredOptions,
      [key('write', 'sheets')]: { defer_loading: true, run_in_background: true },
    };
    expect(decide({ toolOptions, backgroundToolsEnabled: true })).toBe(false);
    expect(decide({ toolOptions, backgroundToolsEnabled: false })).toBe(true);
  });

  it('keeps the turn-start prompt for a wildcard background opt-in', () => {
    const toolOptions = { ...deferredOptions, '*': { run_in_background: true } };
    expect(decide({ toolOptions, backgroundToolsEnabled: true })).toBe(false);
  });

  it('accepts a canonical key whose entry keeps the prefixed upstream name', () => {
    const catalog = {
      [key('read', 'sheets')]: { serverToolName: 'sheets_read' },
      [key('write', 'sheets')]: {},
    } as unknown as LCAvailableTools;
    expect(decide({ catalog })).toBe(true);
  });

  it('matches a stored pre-strip key against its catalog entry', () => {
    const stored = key('sheets_read', 'sheets');
    const catalog = {
      [key('read', 'sheets')]: { serverToolName: 'sheets_read' },
    } as unknown as LCAvailableTools;
    const options = { [stored]: { defer_loading: true } };
    expect(decide({ tools: [stored], toolOptions: options, catalog })).toBe(true);
    expect(
      decide({
        tools: [stored],
        toolOptions: options,
        catalog: { [key('read', 'sheets')]: {} } as LCAvailableTools,
      }),
    ).toBe(false);
  });

  it('reads options saved under the other spelling of a selected tool', () => {
    const stored = key('sheets_read', 'sheets');
    const current = key('read', 'sheets');
    const catalog = {
      [current]: { serverToolName: 'sheets_read' },
    } as unknown as LCAvailableTools;

    expect(
      decide({ tools: [stored], toolOptions: { [current]: { defer_loading: true } }, catalog }),
    ).toBe(true);
    expect(
      decide({ tools: [current], toolOptions: { [stored]: { defer_loading: true } }, catalog }),
    ).toBe(true);
    expect(
      decide({
        tools: [current],
        toolOptions: { [stored]: { defer_loading: true, run_in_background: true } },
        backgroundToolsEnabled: true,
        catalog,
      }),
    ).toBe(false);
  });

  it('prefers options saved under the selected spelling over its alias', () => {
    const stored = key('sheets_read', 'sheets');
    const current = key('read', 'sheets');
    const catalog = {
      [current]: { serverToolName: 'sheets_read' },
    } as unknown as LCAvailableTools;
    const toolOptions = { [stored]: { defer_loading: false }, [current]: { defer_loading: true } };

    expect(decide({ tools: [stored], toolOptions, catalog })).toBe(false);
  });

  it('does not alias options without a catalog proving the identity', () => {
    const stored = key('sheets_read', 'sheets');
    const toolOptions = { [key('read', 'sheets')]: { defer_loading: true } };

    expect(decide({ tools: [stored], toolOptions })).toBe(false);
  });

  it('does not require OAuth to be configured up front', () => {
    expect(decide({ serverConfig: { ...onUseConfig, requiresOAuth: false } })).toBe(true);
  });

  it('keeps the turn-start prompt without a declared catalog', () => {
    expect(decide({ serverConfig: { ...onUseConfig, oauthToolCatalog: undefined } })).toBe(false);
    expect(decide({ serverConfig: { ...onUseConfig, oauthToolCatalog: [] } })).toBe(false);
  });
});

describe('createMCPOAuthDeferral', () => {
  const declared = (name: string, description: string): LCFunctionTool => ({
    type: 'function',
    ['function']: {
      name: key(name, 'sheets'),
      description,
      parameters: { type: 'object', properties: {} },
    },
  });
  const declaredCatalog: LCAvailableTools = {
    [key('read', 'sheets')]: declared('read', 'Read a sheet'),
    [key('write', 'sheets')]: declared('write', 'Write a sheet'),
  };
  const ownCatalog = declaredCatalog;

  const create = () => {
    const pendingOAuthServers = new Set(['sheets']);
    const pendingOAuthStarts = new Map<string, unknown>([['sheets', { authURL: 'x' }]]);
    const rememberAvailableTools = jest.fn();
    const tracker = createMCPOAuthDeferral({
      tools: sheetsTools,
      toolOptions: deferredOptions,
      deferredToolsEnabled: true,
      knownServerNames: ['sheets'],
      pendingOAuthServers,
      pendingOAuthStarts,
      rememberAvailableTools,
    });
    return { tracker, pendingOAuthServers, pendingOAuthStarts, rememberAvailableTools };
  };

  it('withdraws the turn-start prompt and offers the declared catalog', () => {
    const { tracker, pendingOAuthServers, pendingOAuthStarts, rememberAvailableTools } = create();

    expect(tracker.deferSignIn('sheets', onUseConfig)).toEqual(declaredCatalog);
    expect(pendingOAuthServers.has('sheets')).toBe(false);
    expect(pendingOAuthStarts.has('sheets')).toBe(false);
    expect(rememberAvailableTools).toHaveBeenCalledWith('sheets', declaredCatalog);
    expect(tracker.hasSignInDecision('sheets')).toBe(true);
  });

  it('keeps the turn-start prompt for a server that does not qualify', () => {
    const { tracker, pendingOAuthServers, rememberAvailableTools } = create();
    const onStart = { ...onUseConfig, oauthPrompt: 'on_start' as const };

    expect(tracker.deferSignIn('sheets', onStart)).toBeNull();
    expect(pendingOAuthServers.has('sheets')).toBe(true);
    expect(rememberAvailableTools).not.toHaveBeenCalled();
  });

  it('keeps the turn-start prompt when the declared catalog misses a selected tool', () => {
    const { tracker, pendingOAuthServers } = create();
    const partial = { ...onUseConfig, oauthToolCatalog: [{ name: 'read' }] };

    expect(tracker.deferSignIn('sheets', partial)).toBeNull();
    expect(pendingOAuthServers.has('sheets')).toBe(true);
    expect(tracker.hasSignInDecision('sheets')).toBe(true);
  });

  it('defers after a reconnect that found no tools while sign-in is pending', () => {
    const { tracker } = create();

    expect(tracker.resolveReconnectTools('sheets', onUseConfig, {})).toEqual(declaredCatalog);
  });

  it('withdraws the prompt when discovery without a token finds the selected tools', () => {
    const { tracker, pendingOAuthServers, rememberAvailableTools } = create();

    expect(tracker.resolveReconnectTools('sheets', onUseConfig, ownCatalog)).toBe(ownCatalog);
    expect(pendingOAuthServers.has('sheets')).toBe(false);
    expect(rememberAvailableTools).toHaveBeenCalledWith('sheets', ownCatalog);
  });

  it('keeps the prompt when the tools a reconnect found do not qualify', () => {
    const { tracker, pendingOAuthServers } = create();
    const onStart = { ...onUseConfig, oauthPrompt: 'on_start' as const };

    expect(tracker.resolveReconnectTools('sheets', onStart, ownCatalog)).toBe(ownCatalog);
    expect(pendingOAuthServers.has('sheets')).toBe(true);
  });

  it('keeps the tools a reconnect found without a pending sign-in', () => {
    const { tracker, pendingOAuthServers } = create();
    pendingOAuthServers.delete('sheets');

    expect(tracker.resolveReconnectTools('sheets', onUseConfig, ownCatalog)).toBe(ownCatalog);
    expect(tracker.hasSignInDecision('sheets')).toBe(false);
  });

  it('does not defer a reconnect that failed without a pending sign-in', () => {
    const { tracker, pendingOAuthServers } = create();
    pendingOAuthServers.delete('sheets');

    expect(tracker.resolveReconnectTools('sheets', onUseConfig, null)).toBeNull();
    expect(tracker.hasSignInDecision('sheets')).toBe(false);
  });

  it('queues the turn-start prompt only for a server that does not defer', async () => {
    const { tracker } = create();
    const prompt = jest.fn().mockResolvedValue(true);

    await tracker.promptUnlessDeferred('sheets', onUseConfig, ownCatalog, prompt);
    expect(prompt).not.toHaveBeenCalled();

    const onStart = { ...onUseConfig, oauthPrompt: 'on_start' as const };
    await tracker.promptUnlessDeferred('sheets', onStart, ownCatalog, prompt);
    expect(prompt).toHaveBeenCalledTimes(1);

    const partial = { [key('read', 'sheets')]: ownCatalog[key('read', 'sheets')] };
    await tracker.promptUnlessDeferred('sheets', onUseConfig, partial, prompt);
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it('queues the turn-start prompt for a cached catalog without a declared one', async () => {
    const { tracker } = create();
    const prompt = jest.fn().mockResolvedValue(true);
    const undeclared = { ...onUseConfig, oauthToolCatalog: undefined };

    await tracker.promptUnlessDeferred('sheets', undeclared, ownCatalog, prompt);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(tracker.hasSignInDecision('sheets')).toBe(true);
  });

  it('records a server deferred with its own catalog', async () => {
    const { tracker, pendingOAuthServers } = create();
    pendingOAuthServers.delete('sheets');

    await tracker.promptUnlessDeferred('sheets', onUseConfig, ownCatalog, jest.fn());
    expect(tracker.hasSignInDecision('sheets')).toBe(true);
  });
});
