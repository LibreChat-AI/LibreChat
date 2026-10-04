import type { CodeWorkspaceRoutingAgent, CodeWorkspaceSelection } from './workspace';
import { resolveCodeEnvironmentSelection, resolveCodeWorkspaceInheritance } from './workspace';
import { appendAgentIdSuffix } from '../agents/identity';

const SKYNET = 'code-skynet';
const LIA_RAG = 'code-lia-rag';
const SPARE = 'code-spare';
const attached = new Set([SKYNET, LIA_RAG, SPARE]);
const isAttachedEnvironment = (id: string): boolean => attached.has(id);

function agent(
  id: string,
  overrides: Partial<CodeWorkspaceRoutingAgent> = {},
): CodeWorkspaceRoutingAgent {
  return {
    id,
    routesCode: true,
    environmentId: SKYNET,
    environmentIds: [LIA_RAG],
    allowSelection: true,
    ...overrides,
  };
}

function graph(...agents: CodeWorkspaceRoutingAgent[]): Map<string, CodeWorkspaceRoutingAgent> {
  return new Map(agents.map((entry) => [entry.id, entry]));
}

function route(
  entry: CodeWorkspaceRoutingAgent,
  selections: CodeWorkspaceSelection[],
  inheritance: ReadonlyMap<string, string>,
): ReturnType<typeof resolveCodeEnvironmentSelection> {
  return resolveCodeEnvironmentSelection({
    agentId: entry.id,
    environmentId: entry.environmentId,
    environmentIds: entry.environmentIds,
    allowSelection: entry.allowSelection,
    selections,
    inheritedEnvironmentId: inheritance.get(entry.id),
  });
}

describe('subagent machine inheritance', () => {
  const lia = agent('lia', { subagentIds: ['reviewer'] });
  const reviewer = agent('reviewer');
  /** The demo incident: Lia moved to her RAG machine, the reviewer stayed on Code API's checkout. */
  const incident: CodeWorkspaceSelection[] = [
    { environmentId: SKYNET, workspaceId: 'code-api' },
    { environmentId: LIA_RAG, workspaceId: 'agents', agentIds: ['lia'] },
  ];

  it("routes the reviewer to Lia's machine instead of its own default", () => {
    const inheritance = resolveCodeWorkspaceInheritance({
      selections: incident,
      rootIds: ['lia'],
      agents: graph(lia, reviewer),
      isAttachedEnvironment,
    });
    expect(inheritance).toEqual(new Map([['reviewer', LIA_RAG]]));
    expect(route(reviewer, incident, new Map())).toEqual({ valid: true, environmentId: SKYNET });
    expect(route(reviewer, incident, inheritance)).toEqual({
      valid: true,
      environmentId: LIA_RAG,
    });
    expect(route(lia, incident, inheritance)).toEqual({ valid: true, environmentId: LIA_RAG });
  });

  it('routes a child with no selection of its own instead of rejecting it', () => {
    const selections = [{ environmentId: LIA_RAG, workspaceId: 'agents', agentIds: ['lia'] }];
    const inheritance = resolveCodeWorkspaceInheritance({
      selections,
      rootIds: ['lia'],
      agents: graph(lia, reviewer),
      isAttachedEnvironment,
    });
    expect(route(reviewer, selections, new Map())).toEqual({ valid: false });
    expect(route(reviewer, selections, inheritance)).toEqual({
      valid: true,
      environmentId: LIA_RAG,
    });
  });

  it('matches the stable owner key for a parallel runtime agent ID', () => {
    const inheritance = resolveCodeWorkspaceInheritance({
      selections: incident,
      rootIds: ['lia'],
      agents: graph(lia, reviewer),
      isAttachedEnvironment,
    });
    expect(
      resolveCodeEnvironmentSelection({
        agentId: appendAgentIdSuffix('reviewer', 1),
        environmentId: SKYNET,
        environmentIds: [LIA_RAG],
        allowSelection: true,
        selections: incident,
        inheritedEnvironmentId: inheritance.get('reviewer'),
      }),
    ).toEqual({ valid: true, environmentId: LIA_RAG });
  });

  it("keeps a child on its own default when the parent's machine is not on its allowlist", () => {
    const narrow = agent('reviewer', { environmentIds: [SPARE] });
    const inheritance = resolveCodeWorkspaceInheritance({
      selections: incident,
      rootIds: ['lia'],
      agents: graph(lia, narrow),
      isAttachedEnvironment,
    });
    expect(inheritance.size).toBe(0);
    expect(route(narrow, incident, inheritance)).toEqual({ valid: true, environmentId: SKYNET });
  });

  it('never applies an allowlist where per-chat machine choice does not apply', () => {
    const fixed = agent('reviewer', { allowSelection: false });
    const inheritance = resolveCodeWorkspaceInheritance({
      selections: incident,
      rootIds: ['lia'],
      agents: graph(lia, fixed),
      isAttachedEnvironment,
    });
    expect(inheritance.size).toBe(0);
    expect(
      resolveCodeEnvironmentSelection({
        agentId: 'reviewer',
        environmentId: SKYNET,
        environmentIds: [LIA_RAG],
        allowSelection: false,
        selections: incident,
        inheritedEnvironmentId: LIA_RAG,
      }),
    ).toEqual({ valid: true, environmentId: SKYNET });
  });

  it('lets an explicit assignment for the child win over its parent', () => {
    const selections: CodeWorkspaceSelection[] = [
      { environmentId: SKYNET, workspaceId: 'code-api', agentIds: ['reviewer'] },
      { environmentId: LIA_RAG, workspaceId: 'agents', agentIds: ['lia'] },
    ];
    const inheritance = resolveCodeWorkspaceInheritance({
      selections,
      rootIds: ['lia'],
      agents: graph(lia, reviewer),
      isAttachedEnvironment,
    });
    expect(inheritance.size).toBe(0);
    expect(
      resolveCodeEnvironmentSelection({
        agentId: 'reviewer',
        environmentId: SKYNET,
        environmentIds: [LIA_RAG],
        allowSelection: true,
        selections,
        inheritedEnvironmentId: LIA_RAG,
      }),
    ).toEqual({ valid: true, environmentId: SKYNET });
  });

  it('does not inherit a machine the principal cannot use', () => {
    const inheritance = resolveCodeWorkspaceInheritance({
      selections: incident,
      rootIds: ['lia'],
      agents: graph(lia, reviewer),
      isAttachedEnvironment: (id) => id !== LIA_RAG,
    });
    expect(inheritance.size).toBe(0);
  });

  it('does not inherit a machine the conversation never selected', () => {
    const parent = agent('lia', { subagentIds: ['reviewer'], resolvedEnvironmentId: LIA_RAG });
    const selections = [{ environmentId: SKYNET, workspaceId: 'code-api' }];
    const inheritance = resolveCodeWorkspaceInheritance({
      selections,
      rootIds: ['lia'],
      agents: graph(parent, reviewer),
      isAttachedEnvironment,
    });
    expect(inheritance.size).toBe(0);
    expect(
      resolveCodeEnvironmentSelection({
        agentId: 'reviewer',
        environmentId: SKYNET,
        environmentIds: [LIA_RAG],
        allowSelection: true,
        selections,
        inheritedEnvironmentId: LIA_RAG,
      }),
    ).toEqual({ valid: true, environmentId: SKYNET });
  });

  it('leaves the single legacy selection routing unchanged', () => {
    const selections = [{ environmentId: LIA_RAG, workspaceId: 'agents' }];
    const parent = agent('lia', {
      environmentId: LIA_RAG,
      environmentIds: [],
      subagentIds: ['a', 'b'],
    });
    const allowed = agent('a');
    const disallowed = agent('b', { environmentIds: [SPARE] });
    const inheritance = resolveCodeWorkspaceInheritance({
      selections,
      rootIds: ['lia'],
      agents: graph(parent, allowed, disallowed),
      isAttachedEnvironment,
    });
    for (const entry of [parent, allowed, disallowed]) {
      expect(route(entry, selections, inheritance)).toEqual(route(entry, selections, new Map()));
    }
    expect(route(allowed, selections, inheritance)).toEqual({
      valid: true,
      environmentId: LIA_RAG,
    });
    expect(route(disallowed, selections, inheritance)).toEqual({ valid: false });
  });

  it('passes a machine through a subagent that does not run code', () => {
    const planner = agent('planner', { routesCode: false, subagentIds: ['coder'] });
    const parent = agent('lia', { subagentIds: ['planner'] });
    const coder = agent('coder');
    const inheritance = resolveCodeWorkspaceInheritance({
      selections: incident,
      rootIds: ['lia'],
      agents: graph(parent, planner, coder),
      isAttachedEnvironment,
    });
    expect(inheritance).toEqual(new Map([['coder', LIA_RAG]]));
  });

  it('follows a chain of inherited routes', () => {
    const parent = agent('lia', { subagentIds: ['reviewer'] });
    const middle = agent('reviewer', { subagentIds: ['verifier'] });
    const leaf = agent('verifier');
    const inheritance = resolveCodeWorkspaceInheritance({
      selections: incident,
      rootIds: ['lia'],
      agents: graph(parent, middle, leaf),
      isAttachedEnvironment,
    });
    expect(inheritance).toEqual(
      new Map([
        ['reviewer', LIA_RAG],
        ['verifier', LIA_RAG],
      ]),
    );
  });

  it('keeps a subagent on its own route when its parents disagree', () => {
    const selections: CodeWorkspaceSelection[] = [
      { environmentId: SKYNET, workspaceId: 'code-api' },
      { environmentId: LIA_RAG, workspaceId: 'agents', agentIds: ['lia'] },
      { environmentId: SPARE, workspaceId: 'spare', agentIds: ['other'] },
    ];
    const left = agent('lia', { subagentIds: ['shared'] });
    const right = agent('other', { environmentIds: [SPARE], subagentIds: ['shared'] });
    const shared = agent('shared', { environmentIds: [LIA_RAG, SPARE] });
    const inheritance = resolveCodeWorkspaceInheritance({
      selections,
      rootIds: ['lia', 'other'],
      agents: graph(left, right, shared),
      isAttachedEnvironment,
    });
    expect(inheritance.size).toBe(0);
  });

  it('keeps its own route when a deeper spawning path runs on another machine', () => {
    const selections: CodeWorkspaceSelection[] = [
      { environmentId: SKYNET, workspaceId: 'code-api' },
      { environmentId: LIA_RAG, workspaceId: 'agents', agentIds: ['lia'] },
      { environmentId: SPARE, workspaceId: 'spare', agentIds: ['other'] },
    ];
    const direct = agent('lia', { subagentIds: ['shared'] });
    const other = agent('other', { environmentIds: [SPARE], subagentIds: ['planner'] });
    const planner = agent('planner', { routesCode: false, subagentIds: ['shared'] });
    const shared = agent('shared', { environmentIds: [LIA_RAG, SPARE] });
    const inheritance = resolveCodeWorkspaceInheritance({
      selections,
      rootIds: ['lia', 'other'],
      agents: graph(direct, other, planner, shared),
      isAttachedEnvironment,
    });
    expect(inheritance.size).toBe(0);
  });

  it('inherits when every spawning path, at any depth, runs on the same machine', () => {
    const parent = agent('lia', { subagentIds: ['shared', 'planner'] });
    const planner = agent('planner', { routesCode: false, subagentIds: ['shared'] });
    const shared = agent('shared');
    const inheritance = resolveCodeWorkspaceInheritance({
      selections: incident,
      rootIds: ['lia'],
      agents: graph(parent, planner, shared),
      isAttachedEnvironment,
    });
    expect(inheritance).toEqual(new Map([['shared', LIA_RAG]]));
  });

  it('ignores a spawn back-edge the run prunes, as the descriptor tree does', () => {
    const parent = agent('lia', { subagentIds: ['left'] });
    const left = agent('left', { subagentIds: ['right'] });
    const right = agent('right', { subagentIds: ['left'] });
    const inheritance = resolveCodeWorkspaceInheritance({
      selections: incident,
      rootIds: ['lia'],
      agents: graph(parent, left, right),
      isAttachedEnvironment,
    });
    expect(inheritance).toEqual(
      new Map([
        ['left', LIA_RAG],
        ['right', LIA_RAG],
      ]),
    );
  });

  it("routes subagents that spawn each other with their outside parent's machine", () => {
    const parent = agent('lia', { subagentIds: ['left', 'right'] });
    const left = agent('left', { subagentIds: ['right'] });
    const right = agent('right', { subagentIds: ['left'] });
    const inheritance = resolveCodeWorkspaceInheritance({
      selections: incident,
      rootIds: ['lia'],
      agents: graph(parent, left, right),
      isAttachedEnvironment,
    });
    expect(inheritance).toEqual(
      new Map([
        ['left', LIA_RAG],
        ['right', LIA_RAG],
      ]),
    );
  });

  it('settles independent mutually spawning groups separately', () => {
    const selections: CodeWorkspaceSelection[] = [
      { environmentId: SKYNET, workspaceId: 'code-api' },
      { environmentId: LIA_RAG, workspaceId: 'agents', agentIds: ['lia'] },
      { environmentId: SPARE, workspaceId: 'spare', agentIds: ['other'] },
    ];
    const lia = agent('lia', { subagentIds: ['a1', 'a2'] });
    const other = agent('other', { environmentIds: [SPARE], subagentIds: ['b1', 'b2'] });
    const pair = (id: string, peer: string) =>
      agent(id, { environmentIds: [LIA_RAG, SPARE], subagentIds: [peer] });
    const inheritance = resolveCodeWorkspaceInheritance({
      selections,
      rootIds: ['lia', 'other'],
      agents: graph(
        lia,
        other,
        pair('a1', 'a2'),
        pair('a2', 'a1'),
        pair('b1', 'b2'),
        pair('b2', 'b1'),
      ),
      isAttachedEnvironment,
    });
    expect(inheritance).toEqual(
      new Map([
        ['a1', LIA_RAG],
        ['a2', LIA_RAG],
        ['b1', SPARE],
        ['b2', SPARE],
      ]),
    );
  });

  it('keeps a mutually spawning group on its own routes when one member is assigned elsewhere', () => {
    const selections: CodeWorkspaceSelection[] = [
      { environmentId: SKYNET, workspaceId: 'code-api', agentIds: ['right'] },
      { environmentId: LIA_RAG, workspaceId: 'agents', agentIds: ['lia'] },
    ];
    const parent = agent('lia', { subagentIds: ['left', 'right'] });
    const left = agent('left', { subagentIds: ['right'] });
    const right = agent('right', { subagentIds: ['left'] });
    const inheritance = resolveCodeWorkspaceInheritance({
      selections,
      rootIds: ['lia'],
      agents: graph(parent, left, right),
      isAttachedEnvironment,
    });
    expect(inheritance.size).toBe(0);
  });

  it('never re-routes a root, even when another root lists it as a subagent', () => {
    const parent = agent('lia', { subagentIds: ['peer'] });
    const peer = agent('peer');
    const inheritance = resolveCodeWorkspaceInheritance({
      selections: incident,
      rootIds: ['lia', 'peer'],
      agents: graph(parent, peer),
      isAttachedEnvironment,
    });
    expect(inheritance.size).toBe(0);
  });

  it('derives the same routes regardless of traversal order', () => {
    const parent = agent('lia', { subagentIds: ['reviewer', 'verifier'] });
    const second = agent('verifier', { environmentIds: [SPARE] });
    const forward = resolveCodeWorkspaceInheritance({
      selections: incident,
      rootIds: ['lia'],
      agents: graph(parent, reviewer, second),
      isAttachedEnvironment,
    });
    const reversed = resolveCodeWorkspaceInheritance({
      selections: [...incident].reverse(),
      rootIds: ['lia'],
      agents: graph(second, reviewer, agent('lia', { subagentIds: ['verifier', 'reviewer'] })),
      isAttachedEnvironment,
    });
    expect(Array.from(forward).sort()).toEqual(Array.from(reversed).sort());
    expect(forward).toEqual(new Map([['reviewer', LIA_RAG]]));
  });

  it('ignores an empty or invalid decision', () => {
    for (const selections of [undefined, [], [{ environmentId: '' }]]) {
      expect(
        resolveCodeWorkspaceInheritance({
          selections,
          rootIds: ['lia'],
          agents: graph(lia, reviewer),
          isAttachedEnvironment,
        }).size,
      ).toBe(0);
    }
  });
});
