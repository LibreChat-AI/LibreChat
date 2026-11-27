import type * as t from '~/mcp/types';
import { MCPServersRegistry } from '~/mcp/registry/MCPServersRegistry';
import { MCPServerInspector } from '~/mcp/registry/MCPServerInspector';
import { resolveServerInstructions } from '~/mcp/utils';

jest.mock('~/mcp/registry/MCPServerInspector');
jest.mock('~/mcp/registry/db/ServerConfigsDB', () => ({
  ServerConfigsDB: jest.fn().mockImplementation(() => ({
    get: jest.fn().mockResolvedValue(undefined),
    getAll: jest.fn().mockResolvedValue({}),
    add: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue(undefined),
    upsert: jest.fn().mockResolvedValue(undefined),
    remove: jest.fn().mockResolvedValue(undefined),
    reset: jest.fn().mockResolvedValue(undefined),
  })),
}));

const mockMongoose = {} as typeof import('mongoose');
const INSTRUCTIONS = 'Use these tools to do the thing.';

const yamlConfig: t.MCPOptions = {
  type: 'stdio',
  command: 'node',
  args: ['tools.js'],
  serverInstructions: true,
};

/** Mirrors MCPServerInspector: an enabled `serverInstructions` resolves to the text the
 * server advertises, while the declaration itself is left untouched. */
function inspectLikeProduction(rawConfig: t.MCPOptions): t.ParsedServerConfig {
  const parsed = {
    ...rawConfig,
    tools: 'tool_a, tool_b',
    capabilities: '{}',
  } as t.ParsedServerConfig;
  if (parsed.serverInstructions === true || parsed.serverInstructions === 'true') {
    parsed.resolvedInstructions = INSTRUCTIONS;
  }
  return parsed;
}

describe('MCPServersRegistry — YAML servers declaring serverInstructions', () => {
  let registry: MCPServersRegistry;
  let inspectSpy: jest.SpyInstance;

  beforeEach(async () => {
    (MCPServersRegistry as unknown as { instance: undefined }).instance = undefined;
    MCPServersRegistry.createInstance(mockMongoose);
    registry = MCPServersRegistry.getInstance();

    inspectSpy = jest
      .spyOn(MCPServerInspector, 'inspect')
      .mockImplementation(async (_serverName: string, rawConfig: t.MCPOptions) =>
        inspectLikeProduction(rawConfig),
      );

    await registry.reset();
  });

  afterEach(() => {
    inspectSpy.mockClear();
  });

  /** Regression: the inspector used to overwrite `serverInstructions` with the fetched text,
   * so the unmodified-YAML guard compared `true` against a string, re-inspected the server,
   * and produced a second config the live app connection then measured as stale. */
  it('should not re-inspect an unmodified YAML server that declares serverInstructions', async () => {
    await registry.addServer('instr', yamlConfig, 'CACHE');
    inspectSpy.mockClear();

    const result = await registry.ensureConfigServers({ instr: yamlConfig });

    expect(inspectSpy).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty('instr');
  });

  it('should keep the effective config app-eligible for a user-scoped resolve', async () => {
    await registry.addServer('instr', yamlConfig, 'CACHE');

    const configServers = await registry.ensureConfigServers({ instr: yamlConfig });
    const effective = await registry.getServerConfig('instr', 'user-1', configServers);

    expect(effective).toBeDefined();
    expect(await registry.isAppServerConfig('instr', effective!)).toBe(true);
  });

  it('should preserve the operator declaration and expose the fetched text separately', async () => {
    const { config } = await registry.addServer('instr', yamlConfig, 'CACHE');

    expect(config.serverInstructions).toBe(true);
    expect(config.resolvedInstructions).toBe(INSTRUCTIONS);
    expect(resolveServerInstructions(config)).toBe(INSTRUCTIONS);
  });

  it('should still detect a genuine admin override of serverInstructions', async () => {
    await registry.addServer('instr', yamlConfig, 'CACHE');
    inspectSpy.mockClear();

    const overridden: t.MCPOptions = { ...yamlConfig, serverInstructions: 'Custom instructions' };
    const result = await registry.ensureConfigServers({ instr: overridden });

    expect(inspectSpy).toHaveBeenCalledTimes(1);
    expect(result).toHaveProperty('instr');
  });
});

describe('resolveServerInstructions', () => {
  const base = { type: 'stdio', command: 'node' } as t.ParsedServerConfig;

  it('should resolve an enabled declaration to the fetched text', () => {
    expect(
      resolveServerInstructions({
        ...base,
        serverInstructions: true,
        resolvedInstructions: INSTRUCTIONS,
      }),
    ).toBe(INSTRUCTIONS);
  });

  it('should resolve the string "true" to the fetched text', () => {
    expect(
      resolveServerInstructions({
        ...base,
        serverInstructions: 'true',
        resolvedInstructions: INSTRUCTIONS,
      }),
    ).toBe(INSTRUCTIONS);
  });

  it('should use an operator-authored string verbatim', () => {
    expect(resolveServerInstructions({ ...base, serverInstructions: 'Custom' })).toBe('Custom');
  });

  it('should yield nothing when enabled but the server advertised none', () => {
    expect(resolveServerInstructions({ ...base, serverInstructions: true })).toBeUndefined();
  });

  it('should yield nothing when disabled or unset', () => {
    expect(resolveServerInstructions({ ...base, serverInstructions: false })).toBeUndefined();
    expect(resolveServerInstructions(base)).toBeUndefined();
  });
});
