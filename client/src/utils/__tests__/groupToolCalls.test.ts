import { ContentTypes } from 'librechat-data-provider';
import type { TMessageContentParts } from 'librechat-data-provider';
import type { PartWithIndex } from '~/components/Chat/Messages/Content/ParallelContent';
import { groupSequentialToolCalls } from '../groupToolCalls';

const toolCall = (id: string): TMessageContentParts =>
  ({
    type: ContentTypes.TOOL_CALL,
    [ContentTypes.TOOL_CALL]: { id, name: 'web_search', args: '{}', output: 'ok' },
  }) as unknown as TMessageContentParts;

const think = (text: string): TMessageContentParts =>
  ({ type: ContentTypes.THINK, [ContentTypes.THINK]: text }) as unknown as TMessageContentParts;

const text = (value: string, phase?: 'commentary' | 'final_answer'): TMessageContentParts =>
  ({ type: ContentTypes.TEXT, [ContentTypes.TEXT]: value, phase }) as TMessageContentParts;

const label = (text: string): TMessageContentParts =>
  ({
    type: ContentTypes.ACTIVITY_LABEL,
    [ContentTypes.ACTIVITY_LABEL]: text,
    pending: text.length === 0,
  }) as unknown as TMessageContentParts;

const textPart = (text = 'answer'): TMessageContentParts =>
  ({ type: ContentTypes.TEXT, text }) as unknown as TMessageContentParts;

const transferPart = (): TMessageContentParts =>
  ({
    type: ContentTypes.TOOL_CALL,
    [ContentTypes.TOOL_CALL]: { id: 'x', name: 'lc_transfer_to_agent', args: '{}' },
  }) as unknown as TMessageContentParts;

const withIndex = (parts: TMessageContentParts[]): PartWithIndex[] =>
  parts.map((part, idx) => ({ part, idx }));

describe('groupSequentialToolCalls with activity labels', () => {
  /**
   * Every batch publishes its reservation the moment the batch ends, so an
   * empty label is the NORMAL state while generation is in flight. Reasoning
   * folds into the run either way, so a lone tool call with its thinking
   * still groups, just without a labelPart.
   */
  it('groups a single tool call with its reasoning while the label is empty', () => {
    const grouped = groupSequentialToolCalls(
      withIndex([think('deciding what to search'), toolCall('t1'), label('')]),
    );

    expect(grouped).toHaveLength(1);
    expect(grouped[0]).toMatchObject({ type: 'tool-group' });
    expect((grouped[0] as { labelPart?: PartWithIndex }).labelPart).toBeUndefined();
  });

  /** A blank/failed fill is permanent, and must stay equally invisible. */
  it('keeps legacy splitting for two tool calls when the label never fills', () => {
    const grouped = groupSequentialToolCalls(
      withIndex([toolCall('t1'), toolCall('t2'), label('')]),
    );

    /** Two adjacent tool calls group even without the feature. */
    expect(grouped).toHaveLength(1);
    expect(grouped[0]).toMatchObject({ type: 'tool-group' });
    expect((grouped[0] as { labelPart?: PartWithIndex }).labelPart).toBeUndefined();
  });

  /** Once real text lands the block becomes one labeled group, THINK included. */
  it('absorbs reasoning into a labeled group once the label has text', () => {
    const grouped = groupSequentialToolCalls(
      withIndex([
        think('deciding what to search'),
        toolCall('t1'),
        label('Found the failing spec'),
      ]),
    );

    expect(grouped).toHaveLength(1);
    expect(grouped[0].type).toBe('tool-group');
    const group = grouped[0] as { parts: PartWithIndex[]; labelPart?: PartWithIndex };
    expect(group.parts).toHaveLength(2);
    expect(group.labelPart?.part).toMatchObject({
      [ContentTypes.ACTIVITY_LABEL]: 'Found the failing spec',
    });
  });

  it('nests typed commentary with its labeled tool batch, but never final text', () => {
    const commentary = groupSequentialToolCalls(
      withIndex([
        text('I will compare both releases.', 'commentary'),
        toolCall('t1'),
        label('Compared both releases'),
      ]),
    );
    expect(commentary).toHaveLength(1);
    expect(commentary[0]).toMatchObject({ type: 'tool-group' });
    expect((commentary[0] as { parts: PartWithIndex[] }).parts).toHaveLength(2);

    const final = groupSequentialToolCalls(
      withIndex([text('Here is the answer.', 'final_answer'), toolCall('t1'), label('Found it')]),
    );
    expect(final).toHaveLength(2);
    expect(final[0]).toMatchObject({ type: 'single' });
    expect(final[1]).toMatchObject({ type: 'tool-group' });
  });

  /** An empty orphan label has nothing to render and no block to delimit. */
  it('drops an empty orphan label entirely', () => {
    expect(groupSequentialToolCalls(withIndex([label('')]))).toEqual([]);
  });

  /**
   * Two consecutive single-call batches whose labels stay blank: with the
   * feature off these adjacent calls merge into one legacy group, so the
   * invisible blank slots must not split them into standalone cards.
   */
  it('merges adjacent single-call batches across blank labels like the feature-off path', () => {
    const grouped = groupSequentialToolCalls(
      withIndex([toolCall('t1'), label(''), toolCall('t2'), label('')]),
    );

    expect(grouped).toHaveLength(1);
    expect(grouped[0]).toMatchObject({ type: 'tool-group' });
    const group = grouped[0] as { parts: PartWithIndex[]; labelPart?: PartWithIndex };
    expect(group.parts.map((p) => p.idx)).toEqual([0, 2]);
    expect(group.labelPart).toBeUndefined();
  });

  /** A pure-handoff batch's label has nothing to head: the transfer card
   *  names the destination, transfers are never groupable, and the label
   *  would render as a stray line after the card. */
  it('drops an orphan label whose batch was only transfer calls', () => {
    const transfer = {
      type: ContentTypes.TOOL_CALL,
      [ContentTypes.TOOL_CALL]: { id: 'x1', name: 'lc_transfer_to_billing', args: '{}' },
    } as unknown as TMessageContentParts;
    const transferLabel = {
      type: ContentTypes.ACTIVITY_LABEL,
      [ContentTypes.ACTIVITY_LABEL]: 'Handed off to billing',
      tool_call_ids: ['x1'],
      pending: false,
    } as unknown as TMessageContentParts;

    const grouped = groupSequentialToolCalls(withIndex([transfer, transferLabel]));

    expect(grouped).toHaveLength(1);
    expect(grouped[0]).toMatchObject({ type: 'single' });
    expect((grouped[0] as { part: PartWithIndex }).part.idx).toBe(0);
  });

  /** Mixed legacy content: an orphan label covering a transfer AND real
   *  calls is equally headless once the block flushed at the transfer. */
  it('drops an orphan label whose batch mixed a transfer with real calls', () => {
    const realTool = {
      type: ContentTypes.TOOL_CALL,
      [ContentTypes.TOOL_CALL]: { id: 't1', name: 'web_search', args: '{}', output: 'ok' },
    } as unknown as TMessageContentParts;
    const transfer = {
      type: ContentTypes.TOOL_CALL,
      [ContentTypes.TOOL_CALL]: { id: 'x1', name: 'lc_transfer_to_billing', args: '{}' },
    } as unknown as TMessageContentParts;
    const mixedLabel = {
      type: ContentTypes.ACTIVITY_LABEL,
      [ContentTypes.ACTIVITY_LABEL]: 'Looked up the refund policy',
      tool_call_ids: ['t1', 'x1'],
      pending: false,
    } as unknown as TMessageContentParts;

    const grouped = groupSequentialToolCalls(withIndex([realTool, transfer, mixedLabel]));

    /** Tool card + handoff card render; the headless label is dropped. */
    expect(grouped).toHaveLength(2);
    expect(grouped.every((entry) => entry.type === 'single')).toBe(true);
  });

  it('keeps rendering an orphan label whose batch had real tool calls', () => {
    const orphanLabel = {
      type: ContentTypes.ACTIVITY_LABEL,
      [ContentTypes.ACTIVITY_LABEL]: 'Searched the docs',
      tool_call_ids: ['t9'],
      pending: false,
    } as unknown as TMessageContentParts;

    const grouped = groupSequentialToolCalls(withIndex([orphanLabel]));

    expect(grouped).toHaveLength(1);
    expect((grouped[0] as { part: PartWithIndex }).part.part).toMatchObject({
      [ContentTypes.ACTIVITY_LABEL]: 'Searched the docs',
    });
  });

  /** A filled label claims only its own batch — never one behind a blank slot. */
  it('stops a filled label from claiming a batch behind a blank label', () => {
    const grouped = groupSequentialToolCalls(
      withIndex([toolCall('t1'), label(''), toolCall('t2'), label('Fetched the docs')]),
    );

    expect(grouped).toHaveLength(2);
    /** The blank-labeled batch renders legacy-style, before the labeled group. */
    expect(grouped[0]).toMatchObject({ type: 'single' });
    expect((grouped[0] as { part: PartWithIndex }).part.idx).toBe(0);
    expect(grouped[1].type).toBe('tool-group');
    const group = grouped[1] as { parts: PartWithIndex[]; labelPart?: PartWithIndex };
    expect(group.parts.map((p) => p.idx)).toEqual([2]);
    expect(group.labelPart?.part).toMatchObject({
      [ContentTypes.ACTIVITY_LABEL]: 'Fetched the docs',
    });
  });
});

describe('groupSequentialToolCalls reasoning transparency', () => {
  it('groups two adjacent tool calls', () => {
    const result = groupSequentialToolCalls(withIndex([toolCall('a'), toolCall('b')]));
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: 'tool-group' });
    expect(result[0].type === 'tool-group' && result[0].parts).toHaveLength(2);
  });

  it('keeps a single tool call ungrouped', () => {
    const result = groupSequentialToolCalls(withIndex([toolCall('a')]));
    expect(result).toEqual([{ type: 'single', part: { part: expect.anything(), idx: 0 } }]);
  });

  it('absorbs reasoning interleaved between tool calls into one group', () => {
    const result = groupSequentialToolCalls(
      withIndex([toolCall('a'), think('mid'), toolCall('b')]),
    );
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('tool-group');
    expect(result[0].type === 'tool-group' && result[0].parts.map((p) => p.idx)).toEqual([0, 1, 2]);
  });

  it('absorbs leading and trailing reasoning around a tool run', () => {
    const result = groupSequentialToolCalls(
      withIndex([think('lead'), toolCall('a'), toolCall('b'), think('trail')]),
    );
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('tool-group');
    expect(result[0].type === 'tool-group' && result[0].parts).toHaveLength(4);
  });

  it('groups a lone tool call wrapped in reasoning', () => {
    const result = groupSequentialToolCalls(
      withIndex([think('lead'), toolCall('a'), think('trail')]),
    );
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('tool-group');
    expect(result[0].type === 'tool-group' && result[0].parts.map((p) => p.idx)).toEqual([0, 1, 2]);
  });

  it('keeps a lone tool call without reasoning inline', () => {
    const result = groupSequentialToolCalls(withIndex([toolCall('a'), textPart()]));
    expect(result.map((g) => g.type)).toEqual(['single', 'single']);
  });

  it('keeps pure reasoning (no tool call) standalone', () => {
    const result = groupSequentialToolCalls(withIndex([think('only'), textPart()]));
    expect(result.map((g) => g.type)).toEqual(['single', 'single']);
  });

  it('does not pull a thought-then-answer tail into a preceding group', () => {
    const result = groupSequentialToolCalls(
      withIndex([toolCall('a'), toolCall('b'), textPart(), think('tail'), textPart('final')]),
    );
    expect(result.map((g) => g.type)).toEqual(['tool-group', 'single', 'single', 'single']);
  });

  it('splits tool runs separated by a non-reasoning part', () => {
    const result = groupSequentialToolCalls(
      withIndex([toolCall('a'), toolCall('b'), textPart(), toolCall('c'), toolCall('d')]),
    );
    expect(result.map((g) => g.type)).toEqual(['tool-group', 'single', 'tool-group']);
  });

  /** An unlabeled group auto-collapses once complete, so commentary folded
   *  into it would hide the assistant's prose behind a generic action
   *  header. Reasoning still folds in; only commentary splits the run. */
  it('keeps unlabeled commentary out of the collapsing tool group', () => {
    const result = groupSequentialToolCalls(
      withIndex([
        toolCall('a'),
        toolCall('b'),
        text('here is what I found so far', 'commentary'),
        toolCall('c'),
        toolCall('d'),
        label(''),
      ]),
    );
    expect(result.map((g) => g.type)).toEqual(['tool-group', 'single', 'tool-group']);
  });

  it('still folds reasoning into a run that commentary split', () => {
    const result = groupSequentialToolCalls(
      withIndex([
        think('deciding'),
        toolCall('a'),
        text('a note mid-run', 'commentary'),
        think('reconsidering'),
        toolCall('b'),
        label(''),
      ]),
    );

    expect(result.map((g) => g.type)).toEqual(['tool-group', 'single', 'tool-group']);
  });

  it('does not group transfer/handoff tool calls', () => {
    const result = groupSequentialToolCalls(withIndex([transferPart(), transferPart()]));
    expect(result.map((g) => g.type)).toEqual(['single', 'single']);
  });
});
