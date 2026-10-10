import { buildDigestTree, localizeDigestSummary } from '../SubagentProgress';

jest.mock('~/utils', () => ({
  cn: (...classes: string[]) => classes.filter(Boolean).join(' '),
  getToolDisplayLabel: (name: string, _localize: unknown, serverNames?: readonly string[]) =>
    name === 'bash_tool' ? 'Code' : (serverNames?.find((server) => name.endsWith(server)) ?? name),
  getRunStepDurationLabels: jest.fn(),
}));

const localize = ((key: string, values?: Record<string, string | number>) =>
  values == null ? key : `${key}(${Object.values(values).join(',')})`) as Parameters<
  typeof localizeDigestSummary
>[1];

describe('localizeDigestSummary', () => {
  it('localizes every fragment of a server tally except tool display names', () => {
    expect(localizeDigestSummary('bash_tool ×3, read_file, text ×2 +4 more', localize)).toBe(
      'Code ×3, read_file, com_ui_subagent_progress_reply ×2, com_ui_subagent_progress_more(4)',
    );
    expect(
      localizeDigestSummary('search_mcp_Google_mcp_Workspace ×2', localize, [
        'Google_mcp_Workspace',
      ]),
    ).toBe('Google_mcp_Workspace ×2');
    expect(localizeDigestSummary('1 turn, 2 tools', localize)).toBe(
      'com_ui_subagent_progress_nested(1,2)',
    );
  });
});

describe('buildDigestTree', () => {
  it('nests nodes under their parent path and keeps ranges and orphans at their level', () => {
    const tree = buildDigestTree([
      { path: '1-5', kind: 'range' },
      { path: '6', kind: 'turn' },
      { path: '6.1-3', kind: 'range' },
      { path: '6.4', kind: 'tool' },
      { path: '6.4.1', kind: 'turn' },
      { path: '6.4.1.1', kind: 'tool' },
      { path: '7.2', kind: 'tool' },
    ]);
    expect(tree.map((entry) => entry.node.path)).toEqual(['1-5', '6', '7.2']);
    expect(tree[1].children.map((entry) => entry.node.path)).toEqual(['6.1-3', '6.4']);
    expect(tree[1].children[1].children[0].children[0].node.path).toBe('6.4.1.1');
  });
});
