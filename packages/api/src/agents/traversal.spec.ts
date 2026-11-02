import { someReachableAgent, collectReachableAgents } from './traversal';

interface TestAgent {
  id: string;
  subagentAgentConfigs?: Array<TestAgent | null>;
  lazySubagentConfigs?: Array<TestAgent | null>;
  subagentGraphMemberMetadata?: Array<TestAgent | null>;
  subagentGraphConfigs?: Array<{ memberConfigs: Array<TestAgent | null> }>;
}

describe('collectReachableAgents', () => {
  it('collects nested and shared agents once in breadth-first order', () => {
    const leaf: TestAgent = { id: 'leaf' };
    const first: TestAgent = { id: 'first', subagentAgentConfigs: [leaf] };
    const second: TestAgent = { id: 'second', subagentAgentConfigs: [leaf] };
    const root: TestAgent = { id: 'root', subagentAgentConfigs: [first, second] };

    expect(collectReachableAgents([root])).toEqual([root, first, second, leaf]);
  });

  it('is cycle-safe while retaining every distinct reachable snapshot', () => {
    const first: TestAgent = { id: 'shared-id' };
    const second: TestAgent = { id: 'shared-id' };
    first.subagentAgentConfigs = [second];
    second.subagentAgentConfigs = [first, null];

    expect(collectReachableAgents([first])).toEqual([first, second]);
  });

  it('collects every effective topology route exactly once', () => {
    const eager: TestAgent = { id: 'eager' };
    const lazy: TestAgent = { id: 'lazy' };
    const graphMember: TestAgent = { id: 'graph-member' };
    const graphMetadata: TestAgent = { id: 'graph-metadata' };
    const root: TestAgent = {
      id: 'root',
      subagentAgentConfigs: [eager],
      lazySubagentConfigs: [lazy],
      subagentGraphMemberMetadata: [graphMetadata],
      subagentGraphConfigs: [{ memberConfigs: [graphMember, eager] }],
    };

    expect(collectReachableAgents([root])).toEqual([root, eager, lazy, graphMetadata, graphMember]);
  });
});

describe('someReachableAgent', () => {
  it('stops before reading matched descendants or consuming later roots', () => {
    const descendants = jest.fn(() => {
      throw new Error('Matched descendants must not be read');
    });
    const matched: TestAgent = {
      id: 'match',
      get lazySubagentConfigs() {
        return descendants();
      },
    };
    const laterRoots = jest.fn(() => {
      throw new Error('Later roots must not be consumed');
    });
    function* roots() {
      yield matched;
      yield laterRoots();
    }
    const predicate = jest.fn((agent: TestAgent) => agent.id === 'match');

    expect(someReachableAgent(roots(), predicate)).toBe(true);
    expect(predicate).toHaveBeenCalledTimes(1);
    expect(descendants).not.toHaveBeenCalled();
    expect(laterRoots).not.toHaveBeenCalled();
  });

  it.each([
    'subagentAgentConfigs',
    'lazySubagentConfigs',
    'subagentGraphMemberMetadata',
    'subagentGraphConfigs',
  ] as const)('finds a descendant through %s without resolving it', (route) => {
    const resolve = jest.fn();
    const matched = { id: 'match', resolve };
    const root: TestAgent = {
      id: 'root',
      ...(route === 'subagentGraphConfigs'
        ? { subagentGraphConfigs: [{ memberConfigs: [matched] }] }
        : { [route]: [matched] }),
    };

    expect(someReachableAgent([root], (agent) => agent.id === 'match')).toBe(true);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('visits every distinct object once in breadth-first order when nothing matches', () => {
    const first: TestAgent = { id: 'same' };
    const second: TestAgent = { id: 'same' };
    const root: TestAgent = {
      id: 'root',
      subagentAgentConfigs: [first, second],
      lazySubagentConfigs: [first],
    };
    first.subagentGraphMemberMetadata = [root, second];
    second.subagentAgentConfigs = [root];
    const predicate = jest.fn(() => false);

    expect(someReachableAgent([null, root, root, undefined], predicate)).toBe(false);
    expect(predicate.mock.calls).toEqual([[root], [first], [second]]);
    expect(collectReachableAgents([null, root, root, undefined])).toEqual([root, first, second]);
  });

  it('stops before inspecting later descendants after a nested match', () => {
    const match: TestAgent = { id: 'match' };
    const later: TestAgent = { id: 'later' };
    const root: TestAgent = { id: 'root', lazySubagentConfigs: [match, later] };
    const predicate = jest.fn((agent: TestAgent) => agent === match);

    expect(someReachableAgent([root], predicate)).toBe(true);
    expect(predicate.mock.calls).toEqual([[root], [match]]);
  });

  it('does not invoke the predicate for empty roots', () => {
    const predicate = jest.fn(() => true);

    expect(someReachableAgent<TestAgent>([], predicate)).toBe(false);
    expect(predicate).not.toHaveBeenCalled();
  });

  it('propagates predicate failures without expanding the matched node', () => {
    const failure = new Error('Predicate failed');
    const descendants = jest.fn();
    const root: TestAgent = {
      id: 'root',
      get subagentAgentConfigs() {
        return descendants();
      },
    };

    expect(() =>
      someReachableAgent([root], () => {
        throw failure;
      }),
    ).toThrow(failure);
    expect(descendants).not.toHaveBeenCalled();
  });
});
