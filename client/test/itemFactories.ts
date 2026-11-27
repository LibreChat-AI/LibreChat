import type { TPlugin, TSkillSummary, Action } from 'librechat-data-provider';
import type { MCPServerInfo } from '~/common';

/**
 * Typed fixture factories for the agent tools catalog specs. They fill every
 * required field so tests can pass only the properties they care about while
 * still validating overrides against the real data-provider contracts (instead
 * of erasing the shape with `as never`).
 */

export function makePlugin(overrides: Partial<TPlugin> = {}): TPlugin {
  return { name: 'Tool', pluginKey: 'tool', ...overrides };
}

export function makeSkill(overrides: Partial<TSkillSummary> = {}): TSkillSummary {
  return {
    _id: 's1',
    name: 'skill',
    description: '',
    author: 'u1',
    authorName: 'User',
    version: 1,
    source: 'inline',
    fileCount: 0,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function makeMcpServer(overrides: Partial<MCPServerInfo> = {}): MCPServerInfo {
  return {
    serverName: 'srv',
    tools: [],
    isConfigured: true,
    isConnected: true,
    metadata: makePlugin({ name: 'srv', pluginKey: 'srv' }),
    ...overrides,
  };
}

export function makeAction(overrides: Partial<Action> = {}): Action {
  return { action_id: 'a1', metadata: {}, version: 1, agent_id: 'agent1', ...overrides } as Action;
}
