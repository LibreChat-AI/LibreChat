import { ContentTypes } from 'librechat-data-provider';
import type { TMessageContentParts } from 'librechat-data-provider';
import { groupParallelContent, lastParallelColumnCursorIdx } from '../ParallelContent';

describe('groupParallelContent', () => {
  const sequentialPart = {
    type: ContentTypes.TEXT,
    text: 'before lanes',
  } as unknown as TMessageContentParts;

  /** Two agents, so the group renders as columns at all — see the lane
   *  demotion suite below. */
  const lanePart = (agentId: string) =>
    ({
      type: ContentTypes.TEXT,
      text: `${agentId} result`,
      groupId: 1,
      agentId,
    }) as unknown as TMessageContentParts;

  test('reports absolute indices for a dense phase segment', () => {
    const first = lanePart('agent-1');
    const second = lanePart('agent-2');

    const grouped = groupParallelContent([sequentialPart, first, second], 4);

    expect(grouped.sequentialParts).toEqual([{ part: sequentialPart, idx: 4 }]);
    expect(grouped.parallelSections[0]?.columns[0]?.parts).toEqual([{ part: first, idx: 5 }]);
    expect(grouped.parallelSections[0]?.columns[1]?.parts).toEqual([{ part: second, idx: 6 }]);
  });

  test('preserves absolute indices for a compacted sparse phase segment', () => {
    const first = lanePart('agent-1');
    const second = lanePart('agent-2');

    const grouped = groupParallelContent([sequentialPart, first, second], 0, [2, 10_000, 10_001]);

    expect(grouped.sequentialParts).toEqual([{ part: sequentialPart, idx: 2 }]);
    expect(grouped.parallelSections[0]?.columns[0]?.parts).toEqual([{ part: first, idx: 10_000 }]);
    expect(grouped.parallelSections[0]?.columns[1]?.parts).toEqual([{ part: second, idx: 10_001 }]);
  });
});

describe('groupParallelContent — lane demotion', () => {
  const lanePart = (agentId: string, text: string, groupId = 1): TMessageContentParts =>
    ({ type: ContentTypes.TEXT, text, agentId, groupId }) as unknown as TMessageContentParts;

  const plainPart = (text: string): TMessageContentParts =>
    ({ type: ContentTypes.TEXT, text }) as unknown as TMessageContentParts;

  it('renders a group backed by one agent sequentially', () => {
    /** A multi-agent graph stamps a group id on every starting node, so an
     *  agent that merely has subagents available carries one on its own
     *  output. One column is not a comparison — a lane there would draw a
     *  second author header and opt the parts out of tool grouping. */
    const thinking = lanePart('agent_a', 'thinking');
    const answer = lanePart('agent_a', 'answer');

    const grouped = groupParallelContent([thinking, answer]);

    expect(grouped.parallelSections).toEqual([]);
    expect(grouped.sequentialParts).toEqual([
      { part: thinking, idx: 0 },
      { part: answer, idx: 1 },
    ]);
  });

  it('keeps columns once a second agent shares the group', () => {
    const primary = lanePart('agent_a', 'primary answer');
    const added = lanePart('agent_b____1', 'added answer');

    const grouped = groupParallelContent([primary, added]);

    expect(grouped.parallelSections).toHaveLength(1);
    expect(grouped.parallelSections[0]?.columns.map((column) => column.agentId)).toEqual([
      'agent_a',
      'agent_b____1',
    ]);
    expect(grouped.sequentialParts).toEqual([]);
  });

  it('restores transcript order after demoting a lone group', () => {
    const preface = plainPart('preface');
    const lane = lanePart('agent_a', 'lane output');
    const closing = plainPart('closing');

    const grouped = groupParallelContent([preface, lane, closing]);

    expect(grouped.sequentialParts.map(({ idx }) => idx)).toEqual([0, 1, 2]);
  });

  it('demotes a lone group beside a real one without dropping its parts', () => {
    const primary = lanePart('agent_a', 'primary answer');
    const added = lanePart('agent_b____1', 'added answer');
    const lone = lanePart('agent_c', 'handoff output', 2);

    const grouped = groupParallelContent([primary, lone, added]);

    expect(grouped.parallelSections).toHaveLength(1);
    expect(grouped.parallelSections[0]?.groupId).toBe(1);
    expect(grouped.sequentialParts).toEqual([{ part: lone, idx: 1 }]);
  });

  it('demotes a group whose only second column is unattributed', () => {
    const attributed = lanePart('agent_a', 'primary answer');
    const unattributed = {
      type: ContentTypes.TEXT,
      text: 'server sent no agent id',
      groupId: 1,
    } as unknown as TMessageContentParts;

    const grouped = groupParallelContent([attributed, unattributed]);

    expect(grouped.parallelSections).toEqual([]);
    expect(grouped.sequentialParts.map(({ idx }) => idx)).toEqual([0, 1]);
  });

  it('demotes a group whose second column is only a handoff marker', () => {
    const output = lanePart('agent_a', 'primary answer');
    const handoff = {
      type: ContentTypes.AGENT_UPDATE,
      [ContentTypes.AGENT_UPDATE]: { agentId: 'agent_b' },
      agentId: 'agent_b',
      groupId: 1,
    } as unknown as TMessageContentParts;

    const grouped = groupParallelContent([output, handoff]);

    expect(grouped.parallelSections).toEqual([]);
    expect(grouped.sequentialParts.map(({ idx }) => idx)).toEqual([0, 1]);
  });

  it('keeps columns when a real dual run also carries a handoff marker', () => {
    const primary = lanePart('agent_a', 'primary answer');
    const added = lanePart('agent_b____1', 'added answer');
    const handoff = {
      type: ContentTypes.AGENT_UPDATE,
      [ContentTypes.AGENT_UPDATE]: { agentId: 'agent_c' },
      agentId: 'agent_c',
      groupId: 1,
    } as unknown as TMessageContentParts;

    const grouped = groupParallelContent([primary, added, handoff]);

    expect(grouped.parallelSections).toHaveLength(1);
    expect(grouped.sequentialParts).toEqual([]);
  });

  it('keeps a slice column when the message says the group has two agents', () => {
    /** A phase marker can hand this slice one agent of a real two-agent group.
     *  Counting the slice alone would demote it and strip the attribution the
     *  sibling slice still shows, so the message-level verdict wins. */
    const primaryOnly = lanePart('agent_a', 'primary answer');

    const grouped = groupParallelContent([primaryOnly], 0, undefined, new Set([1]));

    expect(grouped.parallelSections).toHaveLength(1);
    expect(grouped.parallelSections[0]?.columns.map((column) => column.agentId)).toEqual([
      'agent_a',
    ]);
    expect(grouped.sequentialParts).toEqual([]);
  });
});

describe('lastParallelColumnCursorIdx', () => {
  test('keeps the lane cursor on visible output before an empty placeholder', () => {
    const visible = {
      type: ContentTypes.TEXT,
      text: 'Visible answer',
      groupId: 1,
      agentId: 'agent-1',
    } as unknown as TMessageContentParts;
    const empty = {
      type: ContentTypes.TEXT,
      text: '',
      groupId: 1,
      agentId: 'agent-1',
    } as unknown as TMessageContentParts;

    expect(
      lastParallelColumnCursorIdx([
        { part: visible, idx: 7 },
        { part: empty, idx: 8 },
      ]),
    ).toBe(7);
  });
});
