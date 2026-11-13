import type { MCPOptions } from 'librechat-data-provider';
import {
  getMCPRequestScope,
  getMCPAgentConnectionKey,
  requiresEphemeralUserConnection,
  getMissingRuntimeBodyPlaceholderFields,
} from '../utils';
import { withMCPAgentContext } from '../request';
import { createAgentMCPTool } from '../agent';
import { processMCPEnv } from '~/utils/env';

const config: MCPOptions = {
  type: 'streamable-http',
  url: 'https://mcp.example.com/mcp',
  headers: { 'X-Agent-Id': '{{LIBRECHAT_AGENT_ID}}' },
};

describe('MCP executing agent context', () => {
  it.each(['agent_root', 'agent_child'])(
    'binds construction and invocation for %s in TypeScript',
    async (agentId) => {
      const input = {
        agentId,
        requestBody: { agentId: 'agent_spoofed', conversationId: 'conversation' },
      };
      const callTool = jest.fn().mockResolvedValue(['ok', null]);
      const tool = createAgentMCPTool(input, ({ requestBody, invokeTool }) => ({
        requestBody,
        invoke: () =>
          invokeTool(
            { callTool },
            {
              serverName: 'analytics',
              toolName: 'select',
              provider: 'openai',
              flowManager: {} as Parameters<typeof invokeTool>[1]['flowManager'],
              requestBody: { agentId: 'agent_override', messageId: 'runtime' },
            },
          ),
      }));
      expect(tool.requestBody.agentId).toBe(agentId);
      await expect(tool.invoke()).resolves.toEqual(['ok', null]);
      expect(callTool).toHaveBeenCalledWith(
        expect.objectContaining({
          requestBody: { agentId, messageId: 'runtime' },
        }),
      );
      expect(input.requestBody.agentId).toBe('agent_spoofed');
    },
  );

  it('replaces browser-supplied identity with the tool owner without mutating the request', () => {
    const body = { conversationId: 'conversation', agentId: 'agent_spoofed' };
    const root = withMCPAgentContext(body, 'agent_root');
    const child = withMCPAgentContext(body, 'agent_child');
    expect(body.agentId).toBe('agent_spoofed');
    expect(root.agentId).toBe('agent_root');
    expect(child.agentId).toBe('agent_child');
    expect(processMCPEnv({ options: config, body: root })).toMatchObject({
      headers: { 'X-Agent-Id': 'agent_root' },
    });
    expect(processMCPEnv({ options: config, body: child })).toMatchObject({
      headers: { 'X-Agent-Id': 'agent_child' },
    });
    expect(config).toMatchObject({ headers: { 'X-Agent-Id': '{{LIBRECHAT_AGENT_ID}}' } });
  });

  it.each([undefined, '', 'ephemeral:my preset', 'agent_bad\r\nInjected: header'])(
    'omits absent or unsafe identity: %s',
    (agentId) => {
      const body = withMCPAgentContext({ agentId: 'agent_spoofed' }, agentId);
      expect(processMCPEnv({ options: config, body })).toMatchObject({
        headers: { 'X-Agent-Id': '' },
      });
      expect(getMissingRuntimeBodyPlaceholderFields(config, body)).toEqual([]);
    },
  );

  it('scopes connections by runtime agent identity', () => {
    const root = getMCPAgentConnectionKey('connection', config, { agentId: 'agent_root' });
    const child = getMCPAgentConnectionKey('connection', config, { agentId: 'agent_child' });
    expect(root).not.toBe(child);
    expect(getMCPAgentConnectionKey('connection', config, { agentId: 'agent_root' })).toBe(root);
    expect(getMCPAgentConnectionKey('connection', { ...config, headers: {} })).toBe('connection');
    expect(getMCPRequestScope(config)).toEqual({
      requestScoped: true,
      requiredBodyFields: ['agentId'],
    });
    expect(requiresEphemeralUserConnection(config)).toBe(true);
  });

  it('does not let a custom user variable replace the tool owner', () => {
    expect(
      processMCPEnv({
        options: config,
        body: withMCPAgentContext({}, 'agent_root'),
        customUserVars: { LIBRECHAT_AGENT_ID: 'agent_spoofed' },
      }),
    ).toMatchObject({ headers: { 'X-Agent-Id': 'agent_root' } });
  });

  it('preserves plugin and user-sourced template boundaries', () => {
    for (const source of ['plugin', 'user'] as const) {
      const options = { ...config, source };
      expect(processMCPEnv({ options, body: withMCPAgentContext({}, 'agent_root') })).toMatchObject(
        {
          headers: { 'X-Agent-Id': '{{LIBRECHAT_AGENT_ID}}' },
        },
      );
      expect(getMCPRequestScope(options).requestScoped).toBe(false);
    }
  });
});
