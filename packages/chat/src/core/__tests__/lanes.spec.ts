import { ContentTypes } from 'librechat-data-provider';
import type { TMessageContentParts } from 'librechat-data-provider';
import { hasParallelLanes, laneAgentsByGroup, parallelLaneGroups } from '../lanes';

const lanePart = (agentId?: string, groupId?: number, text = 'output'): TMessageContentParts =>
  ({
    type: ContentTypes.TEXT,
    text,
    ...(agentId == null ? {} : { agentId }),
    ...(groupId == null ? {} : { groupId }),
  }) as unknown as TMessageContentParts;

const placeholder = (agentId: string, groupId: number): TMessageContentParts =>
  ({ type: '', agentId, groupId }) as unknown as TMessageContentParts;

describe('hasParallelLanes', () => {
  it('is false without any group id', () => {
    expect(hasParallelLanes([lanePart('agent_a'), lanePart('agent_a')])).toBe(false);
  });

  it('is false for a group backed by one agent', () => {
    /** A multi-agent graph assigns a group id to every starting node, so an
     *  agent that merely has subagents available carries one on its OWN
     *  output — with no second column it is not parallel content. */
    expect(hasParallelLanes([lanePart('agent_a', 1), lanePart('agent_a', 1)])).toBe(false);
  });

  it('is true once a second agent shares the group', () => {
    expect(hasParallelLanes([lanePart('agent_a', 1), lanePart('agent_b', 1)])).toBe(true);
  });

  it('counts placeholder columns, which a dual run seeds before any content', () => {
    expect(hasParallelLanes([placeholder('agent_a', 1), placeholder('agent_b____1', 1)])).toBe(
      true,
    );
  });

  it('shares one column across parts that carry no agent id', () => {
    expect(hasParallelLanes([lanePart(undefined, 1), lanePart(undefined, 1)])).toBe(false);
  });

  it('ignores holes in a sparse in-run content array', () => {
    const sparse: Array<TMessageContentParts | undefined> = [];
    sparse[0] = lanePart('agent_a', 1);
    sparse[4] = lanePart('agent_b', 1);
    expect(hasParallelLanes(sparse)).toBe(true);
    expect(laneAgentsByGroup(sparse).get(1)?.size).toBe(2);
  });

  it('separates lanes by group id', () => {
    const lanes = laneAgentsByGroup([
      lanePart('agent_a', 1),
      lanePart('agent_b', 1),
      lanePart('agent_c', 2),
    ]);
    expect(lanes.get(1)?.size).toBe(2);
    expect(lanes.get(2)?.size).toBe(1);
  });

  it('collects only the group ids that render as columns', () => {
    const groups = parallelLaneGroups([
      lanePart('agent_a', 1),
      lanePart('agent_b', 1),
      lanePart('agent_c', 2),
    ]);
    expect([...groups]).toEqual([1]);
  });

  it('does not count a part with no agent id as a second lane', () => {
    /** `agentId` and `groupId` are independently optional on a run step, so a
     *  group can hold a part the server never attributed. It shares the
     *  unattributed column, but it is not another agent to compare against. */
    const content = [lanePart('agent_a', 1), lanePart(undefined, 1)];
    expect(hasParallelLanes(content)).toBe(false);
    expect([...parallelLaneGroups(content)]).toEqual([]);
    expect(laneAgentsByGroup(content).get(1)?.size).toBe(2);
  });

  it('does not let a sequential handoff marker claim a lane', () => {
    /** `useStepHandler` stamps an agent update with the CURRENT group id even
     *  when the destination's own run steps carry none, so the marker names a
     *  second agent inside a single-lane group. Counting it split one run into
     *  columns at the handoff. */
    const handoff = {
      type: ContentTypes.AGENT_UPDATE,
      [ContentTypes.AGENT_UPDATE]: { agentId: 'agent_b' },
      agentId: 'agent_b',
      groupId: 1,
    } as unknown as TMessageContentParts;
    const content = [lanePart('agent_a', 1), handoff];

    expect(hasParallelLanes(content)).toBe(false);
    expect(laneAgentsByGroup(content).get(1)?.size).toBe(1);
  });

  it('scans a content array once, and a new array afresh', () => {
    /** One message is scanned by `MultiMessage`, `useContentMetadata` and
     *  `ContentParts` in a single render pass. */
    const content = [lanePart('agent_a', 1), lanePart('agent_b', 1)];

    expect(laneAgentsByGroup(content)).toBe(laneAgentsByGroup(content));
    expect(laneAgentsByGroup([...content])).not.toBe(laneAgentsByGroup(content));
  });

  it('answers for a slice from the message-level groups it is given', () => {
    /** The slice holds one agent of group 1; the message knows better. */
    const slice = [lanePart('agent_a', 1)];
    expect(hasParallelLanes(slice)).toBe(false);
    expect(hasParallelLanes(slice, new Set([1]))).toBe(true);
    expect(hasParallelLanes(slice, new Set([2]))).toBe(false);
  });
});
