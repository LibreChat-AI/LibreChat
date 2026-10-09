import { collectReachableAgents } from './traversal';

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
