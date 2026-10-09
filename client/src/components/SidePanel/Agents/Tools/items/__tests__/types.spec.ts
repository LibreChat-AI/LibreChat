import type { AgentItem, AgentItemKind } from '../types';

describe('AgentItem types', () => {
  test('discriminator narrows the union', () => {
    const builtin: AgentItem = {
      kind: 'builtin',
      id: 'execute_code',
      name: 'Code Interpreter',
      description: 'Run Python',
      iconKey: 'execute_code',
    };

    expect(builtin.kind).toBe('builtin');
    if (builtin.kind === 'builtin') {
      expect(builtin.id).toBe('execute_code');
    }
  });

  test('every AgentItemKind is exhaustively handled (type-level + runtime)', () => {
    const label = (k: AgentItemKind): string => {
      switch (k) {
        case 'builtin':
          return 'builtin';
        case 'tool':
          return 'tool';
        case 'mcp':
          return 'mcp';
        case 'skill':
          return 'skill';
        case 'action':
          return 'action';
        default: {
          const _exhaustive: never = k;
          return _exhaustive;
        }
      }
    };

    const kinds: AgentItemKind[] = ['builtin', 'tool', 'mcp', 'skill', 'action'];
    expect(kinds.map(label)).toEqual(['builtin', 'tool', 'mcp', 'skill', 'action']);
    expect(new Set(kinds).size).toBe(5);
  });
});
