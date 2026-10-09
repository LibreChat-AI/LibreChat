import type { MCPOptions } from 'librechat-data-provider';
import { MCP_PLUGIN_SOURCE, isPluginSourced, processMCPEnv } from './env';

/**
 * Agent Plugins packages are third-party data. §7.2.1 and §9.2 forbid resolving
 * any placeholder a plugin declares, so a plugin configuration must reach the
 * transport byte-for-byte as authored.
 */
describe('processMCPEnv with plugin-sourced configuration', () => {
  const user = { id: 'u1', email: 'someone@example.com' } as never;

  beforeEach(() => {
    process.env.PLUGIN_LEAK_PROBE = 'super-secret-value';
  });

  afterEach(() => {
    delete process.env.PLUGIN_LEAK_PROBE;
  });

  it('identifies plugin provenance', () => {
    expect(isPluginSourced({ source: MCP_PLUGIN_SOURCE })).toBe(true);
    expect(isPluginSourced({ source: 'yaml' })).toBe(false);
    expect(isPluginSourced({})).toBe(false);
    expect(isPluginSourced(undefined)).toBe(false);
  });

  it('leaves an environment placeholder in a header unresolved', () => {
    const options = {
      source: MCP_PLUGIN_SOURCE,
      type: 'streamable-http',
      url: 'https://plugin.example.com/mcp',
      headers: { Authorization: 'Bearer ${PLUGIN_LEAK_PROBE}' },
    } as unknown as MCPOptions;

    const processed = processMCPEnv({ options, user }) as { headers: Record<string, string> };
    expect(processed.headers.Authorization).toBe('Bearer ${PLUGIN_LEAK_PROBE}');
    expect(JSON.stringify(processed)).not.toContain('super-secret-value');
  });

  it('leaves stdio env and args unresolved', () => {
    const options = {
      source: MCP_PLUGIN_SOURCE,
      type: 'stdio',
      command: 'node',
      args: ['--token', '${PLUGIN_LEAK_PROBE}'],
      env: { TOKEN: '${PLUGIN_LEAK_PROBE}' },
    } as unknown as MCPOptions;

    const processed = processMCPEnv({ options, user }) as {
      args: string[];
      env: Record<string, string>;
    };
    expect(processed.args[1]).toBe('${PLUGIN_LEAK_PROBE}');
    expect(processed.env.TOKEN).toBe('${PLUGIN_LEAK_PROBE}');
  });

  it('does not substitute user fields or custom variables', () => {
    const options = {
      source: MCP_PLUGIN_SOURCE,
      type: 'streamable-http',
      url: 'https://plugin.example.com/mcp',
      headers: { 'X-User': '{{LIBRECHAT_USER_EMAIL}}', 'X-Var': '{{MY_KEY}}' },
    } as unknown as MCPOptions;

    const processed = processMCPEnv({
      options,
      user,
      customUserVars: { MY_KEY: 'user-supplied' },
    }) as { headers: Record<string, string> };

    expect(processed.headers['X-User']).toBe('{{LIBRECHAT_USER_EMAIL}}');
    expect(processed.headers['X-Var']).toBe('{{MY_KEY}}');
  });

  it('returns a copy rather than the original object', () => {
    const options = {
      source: MCP_PLUGIN_SOURCE,
      type: 'stdio',
      command: 'node',
      env: { A: 'b' },
    } as unknown as MCPOptions;

    const processed = processMCPEnv({ options }) as { env: Record<string, string> };
    processed.env.A = 'mutated';
    expect((options as unknown as { env: Record<string, string> }).env.A).toBe('b');
  });

  it('still resolves placeholders for operator-authored configuration', () => {
    const options = {
      type: 'streamable-http',
      url: 'https://ops.example.com/mcp',
      headers: { Authorization: 'Bearer ${PLUGIN_LEAK_PROBE}' },
    } as unknown as MCPOptions;

    const processed = processMCPEnv({ options, user }) as { headers: Record<string, string> };
    expect(processed.headers.Authorization).toBe('Bearer super-secret-value');
  });
});
