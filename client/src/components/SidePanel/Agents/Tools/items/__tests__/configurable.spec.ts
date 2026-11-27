import type { AgentItem } from '../types';
import { makePlugin, makeMcpServer, makeSkill, makeAction } from 'test/itemFactories';
import { hasConfigurableSettings } from '../configurable';

const builtin = (id: string, extra: Record<string, unknown> = {}): AgentItem =>
  ({ kind: 'builtin', id, name: '', description: '', iconKey: id, ...extra }) as AgentItem;

describe('hasConfigurableSettings', () => {
  test('builtins with settings are configurable', () => {
    expect(hasConfigurableSettings(builtin('artifacts'))).toBe(true);
    expect(hasConfigurableSettings(builtin('execute_code'))).toBe(true);
    expect(hasConfigurableSettings(builtin('file_search'))).toBe(true);
    expect(hasConfigurableSettings(builtin('context'))).toBe(true);
    expect(hasConfigurableSettings(builtin('memory'))).toBe(true);
  });

  test('web_search is configurable only when auth is user-provided', () => {
    expect(hasConfigurableSettings(builtin('web_search'))).toBe(false);
    expect(hasConfigurableSettings(builtin('web_search', { userProvidedAuth: false }))).toBe(false);
    expect(hasConfigurableSettings(builtin('web_search', { userProvidedAuth: true }))).toBe(true);
  });

  test('mcp and action are always configurable; skills never are', () => {
    const mcp: AgentItem = {
      kind: 'mcp',
      id: 'srv',
      name: 'srv',
      description: '',
      iconKey: 'mcp',
      server: makeMcpServer({ serverName: 'srv' }),
      toolCount: 0,
    };
    const action: AgentItem = {
      kind: 'action',
      id: 'a1',
      name: 'a1',
      description: '',
      iconKey: 'action',
      action: makeAction({ action_id: 'a1' }),
      endpointCount: 0,
    };
    const skill: AgentItem = {
      kind: 'skill',
      id: 's1',
      name: 's1',
      description: '',
      iconKey: 'skill',
      skill: makeSkill({ _id: 's1' }),
    };
    expect(hasConfigurableSettings(mcp)).toBe(true);
    expect(hasConfigurableSettings(action)).toBe(true);
    expect(hasConfigurableSettings(skill)).toBe(false);
  });

  test('a regular tool is configurable only when it needs auth', () => {
    const noAuth: AgentItem = {
      kind: 'tool',
      id: 'dalle',
      name: 'DALL-E',
      description: '',
      iconKey: 'tool',
      plugin: makePlugin({ pluginKey: 'dalle' }),
    };
    const needsAuth: AgentItem = {
      kind: 'tool',
      id: 'serpapi',
      name: 'SerpApi',
      description: '',
      iconKey: 'tool',
      plugin: makePlugin({
        pluginKey: 'serpapi',
        authConfig: [{ authField: 'SERPAPI_API_KEY', label: 'Key', description: '' }],
        authenticated: false,
      }),
    };
    expect(hasConfigurableSettings(noAuth)).toBe(false);
    expect(hasConfigurableSettings(needsAuth)).toBe(true);
  });
});
