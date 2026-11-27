import type { AgentItem } from '../types';
import { makePlugin, makeSkill, makeMcpServer, makeAction } from 'test/itemFactories';
import { getIconForItem } from '../icons';

describe('getIconForItem', () => {
  test('returns icon + color for built-in execute_code', () => {
    const item: AgentItem = {
      kind: 'builtin',
      id: 'execute_code',
      name: 'Code',
      description: '',
      iconKey: 'execute_code',
    };
    const result = getIconForItem(item);
    expect(result.Icon).toBeDefined();
    expect(result.colorClass).toMatch(/series-7/);
  });

  test('returns the Brain icon + series color for built-in memory', () => {
    const item: AgentItem = {
      kind: 'builtin',
      id: 'memory',
      name: 'Memory',
      description: '',
      iconKey: 'memory',
    };
    const result = getIconForItem(item);
    expect(result.Icon).toBeDefined();
    expect(result.colorClass).toMatch(/series-8/);
  });

  test('returns a distinct color class per kind', () => {
    const items: AgentItem[] = [
      {
        kind: 'tool',
        id: 'x',
        name: 'x',
        description: '',
        iconKey: 'fallback',
        plugin: makePlugin(),
      },
      {
        kind: 'mcp',
        id: 'x',
        name: 'x',
        description: '',
        iconKey: 'fallback',
        server: makeMcpServer(),
        toolCount: 0,
      },
      {
        kind: 'skill',
        id: 'x',
        name: 'x',
        description: '',
        iconKey: 'fallback',
        skill: makeSkill(),
      },
      {
        kind: 'action',
        id: 'x',
        name: 'x',
        description: '',
        iconKey: 'fallback',
        action: makeAction(),
        endpointCount: 0,
      },
    ];
    const colors = items.map((item) => getIconForItem(item).colorClass);
    expect(new Set(colors).size).toBe(items.length);
  });

  test('falls back to a generic icon for an unmapped built-in iconKey', () => {
    const item: AgentItem = {
      kind: 'builtin',
      id: 'execute_code',
      name: 'X',
      description: '',
      iconKey: 'unknown_capability',
    };
    const result = getIconForItem(item);
    expect(result.Icon).toBeDefined();
  });
});
