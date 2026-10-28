import type { ActivityLeaf, ActivityTree, ActivityTurn } from './tree';
import { DIGEST_LIMITS, parseDigestRequest, renderDigest, renderSummaryDigest } from './view';
import { summarizeActivityTree } from './tree';

const tool = (
  name: string,
  status: ActivityLeaf['status'] = 'ok',
  extra: Partial<ActivityLeaf> = {},
): ActivityLeaf => ({
  kind: 'tool',
  name,
  status,
  startedAt: 1_000,
  ...(status === 'running' ? {} : { endedAt: 1_400 }),
  ...extra,
});

const turn = (...children: ActivityLeaf[]): ActivityTurn => ({ startedAt: 1_000, children });

function tree(turns: ActivityTurn[], extra: Partial<ActivityTree> = {}): ActivityTree {
  return { version: 1, root: { turns }, updatedAt: 1_500, ...extra };
}

function request(args: Record<string, unknown>) {
  const parsed = parseDigestRequest(args);
  if ('error' in parsed) {
    throw new Error(parsed.error);
  }
  return parsed.request;
}

/** A long-running child: 20 settled turns, then one turn with a call in flight. */
function longRun(): ActivityTree {
  const turns = Array.from({ length: 20 }, (_, index) =>
    turn(
      tool(index % 2 === 0 ? 'bash_tool' : 'read_file', index === 4 ? 'error' : 'ok', {
        label: `Step ${index + 1} intent`,
      }),
    ),
  );
  turns.push(
    turn(
      { kind: 'text', status: 'ok', startedAt: 1_000, endedAt: 1_100, chars: 240 },
      tool('bash_tool', 'running', { label: 'Running jest for background.spec' }),
    ),
  );
  return tree(turns);
}

describe('renderDigest', () => {
  it('folds history into aligned ranges and opens the active turn', () => {
    const digest = renderDigest(longRun(), { now: 43_000, running: true });
    expect(digest).toMatchObject({
      turns: 21,
      tools: 21,
      errors: 1,
      active: '21.2',
      cursor: '21.1',
    });
    expect(digest.nodes.map((node) => node.path)).toEqual([
      '1-5',
      '6-10',
      '11-15',
      '16',
      '17',
      '18',
      '19',
      '20',
      '21',
      '21.1',
      '21.2',
    ]);
    expect(digest.nodes[0]).toMatchObject({
      kind: 'range',
      status: 'error',
      summary: 'bash_tool ×3, read_file ×2',
      errors: 1,
      folded: true,
    });
    expect(digest.nodes[3]).toMatchObject({ kind: 'turn', summary: 'read_file', folded: true });
    expect(digest.truncated).toBeUndefined();
    expect(digest.nodes[digest.nodes.length - 1]).toMatchObject({
      kind: 'tool',
      name: 'bash_tool',
      status: 'running',
      label: 'Running jest for background.spec',
      ms: 42_000,
    });
    expect(digest.idle_ms).toBeUndefined();
  });

  it('returns only nodes after a cursor, and says so when nothing is new', () => {
    const digest = renderDigest(longRun(), {
      now: 2_000,
      running: true,
      request: request({ since: '21.1' }),
    });
    expect(digest.since).toBe('21.1');
    expect(digest.nodes.map((node) => node.path)).toEqual(['21', '21.2']);

    const settled = tree([turn(tool('read_file'), tool('bash_tool'))]);
    const none = renderDigest(settled, {
      now: 2_000,
      running: true,
      request: request({ since: '1.2' }),
    });
    expect(none.nodes).toEqual([]);
    expect(none.note).toBe('No new activity since 1.2.');
    expect(none).toMatchObject({ cursor: '1.2', idle_ms: 500 });
    expect(none.phase).toBeUndefined();

    const fromTurn = renderDigest(longRun(), {
      now: 2_000,
      running: true,
      request: request({ since: '19' }),
    });
    expect(fromTurn.nodes.map((node) => node.path)).toEqual(['20', '20.1', '21', '21.1', '21.2']);
  });

  it('expands one turn, one leaf with its nested run, and ranges of either', () => {
    const nested = tool('subagent', 'running', {
      run: { turns: [turn(tool('web_search')), turn(tool('bash_tool', 'running'))] },
    });
    const source = tree([turn(tool('read_file'), nested, tool('bash_tool', 'error'))]);

    const turnView = renderDigest(source, {
      now: 2_000,
      running: true,
      request: request({ expand: '1' }),
    });
    expect(turnView.expanded).toBe('1');
    expect(turnView.nodes.map((node) => [node.path, node.kind])).toEqual([
      ['1', 'turn'],
      ['1.1', 'tool'],
      ['1.2', 'tool'],
      ['1.3', 'tool'],
    ]);
    expect(turnView.nodes[2]).toMatchObject({ summary: '2 turns, 2 tools', folded: true });
    expect(turnView.active).toBe('1.2.2.1');

    const leafView = renderDigest(source, {
      now: 2_000,
      running: true,
      request: request({ expand: '1.2' }),
    });
    expect(leafView.nodes.map((node) => node.path)).toEqual(['1.2', '1.2.1', '1.2.2']);
    expect(leafView.nodes[0].folded).toBeUndefined();

    const nestedTurn = renderDigest(source, {
      now: 2_000,
      running: true,
      request: request({ expand: '1.2.2' }),
    });
    expect(nestedTurn.nodes.map((node) => node.path)).toEqual(['1.2.2', '1.2.2.1']);

    const childRange = renderDigest(source, {
      now: 2_000,
      running: true,
      request: request({ expand: '1.2-3' }),
    });
    expect(childRange.nodes.map((node) => node.path)).toEqual(['1.2', '1.3']);

    const turnRange = renderDigest(longRun(), {
      now: 2_000,
      running: true,
      request: request({ expand: '3-5' }),
    });
    expect(turnRange.nodes.map((node) => [node.path, node.folded])).toEqual([
      ['3', true],
      ['4', true],
      ['5', true],
    ]);
    expect(turnRange.nodes[2].errors).toBe(1);
  });

  it('explains an address that is evicted or absent', () => {
    const source = tree([turn(tool('read_file'))]);
    source.root.evicted = {
      turns: 30,
      tools: [['bash_tool', 30]],
      otherTools: 0,
      texts: 0,
      errors: 0,
      startedAt: 0,
      endedAt: 900,
    };
    const evicted = renderDigest(source, {
      now: 2_000,
      running: false,
      request: request({ expand: '12' }),
    });
    expect(evicted.nodes).toEqual([
      expect.objectContaining({
        path: '1-30',
        kind: 'range',
        evicted: true,
        summary: 'bash_tool ×30',
      }),
    ]);
    expect(evicted.note).toContain('no longer retained');

    const current = renderDigest(source, {
      now: 2_000,
      running: false,
      request: request({ expand: '31' }),
    });
    expect(current.nodes.map((node) => node.path)).toEqual(['31', '31.1']);

    const missing = renderDigest(source, {
      now: 2_000,
      running: false,
      request: request({ expand: '31.4' }),
    });
    expect(missing).toMatchObject({ nodes: [], note: 'No node at 31.4.' });
  });

  it('stays within the output budget for the largest tree the owner retains', () => {
    const label = 'Inspecting the subagent routing transport for cross-replica claims '.repeat(3);
    const turns = Array.from({ length: 48 }, (_, index) =>
      turn(
        ...Array.from({ length: 6 }, (__, child) =>
          tool(
            `mcp_server_tool_${child}_${'x'.repeat(40)}`,
            index === 47 && child === 5 ? 'running' : 'ok',
            {
              label,
            },
          ),
        ),
      ),
    );
    for (const args of [{}, { since: '1.1' }, { expand: '1-48' }, { expand: '48' }]) {
      const digest = renderDigest(tree(turns), {
        now: 9_000,
        running: true,
        request: request(args),
      });
      expect(JSON.stringify(digest).length).toBeLessThanOrEqual(DIGEST_LIMITS.chars);
      expect(digest.nodes.length).toBeGreaterThan(0);
    }
    const defaultView = renderDigest(tree(turns), { now: 9_000, running: true });
    expect(defaultView.nodes[defaultView.nodes.length - 1]?.path).toBe('48.6');
    const sinceView = renderDigest(tree(turns), {
      now: 9_000,
      running: true,
      request: request({ since: '1.1' }),
    });
    expect(sinceView.nodes[0]).toMatchObject({ kind: 'range', folded: true });
  });

  it('reports a thinking child with nothing in flight', () => {
    const digest = renderDigest(tree([turn(tool('read_file'))], { thinking: true }), {
      now: 4_500,
      running: true,
    });
    expect(digest).toMatchObject({ phase: 'thinking', idle_ms: 3_000 });
    expect(digest.active).toBeUndefined();
  });
});

describe('renderSummaryDigest', () => {
  it('carries counts and only the node in flight', () => {
    const summary = summarizeActivityTree(longRun());
    const digest = renderSummaryDigest(summary, { now: 2_000, running: true });
    expect(digest).toEqual({
      turns: 21,
      tools: 21,
      errors: 1,
      active: '21.2',
      nodes: [
        {
          path: '21.2',
          kind: 'tool',
          status: 'running',
          name: 'bash_tool',
          label: 'Running jest for background.spec',
          ms: 1_000,
        },
      ],
    });
  });
});

describe('parseDigestRequest', () => {
  it('accepts paths, ranges, and cursors, and treats empty strings as unset', () => {
    expect(request({ expand: ' 3.2 ' })).toEqual({ expand: { text: '3.2', segments: [3, 2] } });
    expect(request({ expand: '1-14' })).toEqual({
      expand: { text: '1-14', segments: [1], rangeEnd: 14 },
    });
    expect(request({ since: '7.3' })).toEqual({ since: { text: '7.3', turn: 7, child: 3 } });
    expect(request({ since: '', expand: '' })).toEqual({});
  });

  it('rejects malformed or conflicting navigation', () => {
    for (const args of [
      { expand: '0' },
      { expand: '3-1' },
      { expand: 'abc' },
      { expand: 4 },
      { since: '1.2.3' },
      { since: '0' },
      { since: '7.0' },
      { since: '7', expand: '3' },
      { expand: `${'1.'.repeat(40)}1` },
    ]) {
      expect(parseDigestRequest(args)).toEqual({ error: expect.any(String) });
    }
  });
});
