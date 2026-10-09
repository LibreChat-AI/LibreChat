import { Constants, ContentTypes } from 'librechat-data-provider';
import type { TActivityLabelEvent, TMessage, TMessageContentParts } from 'librechat-data-provider';
import {
  applyActivityLabelPart,
  getActivityLabelText,
  groupActivityPhases,
  lastCursorContentIdx,
  lastVisibleContentIdx,
  offsetActivityPhaseBoundary,
  findActivityLabelMessageIndex,
} from '../activityLabels';

const buildMessage = (content: TMessage['content']): TMessage =>
  ({ messageId: 'm1', isCreatedByUser: false, content }) as TMessage;

const labelPart = (
  overrides: Partial<TActivityLabelEvent['part']> = {},
): TActivityLabelEvent['part'] => ({
  type: ContentTypes.ACTIVITY_LABEL,
  [ContentTypes.ACTIVITY_LABEL]: '',
  pending: true,
  ...overrides,
});

describe('applyActivityLabelPart', () => {
  it('writes the part at its claimed index', () => {
    const message = buildMessage([]);
    const updated = applyActivityLabelPart(message, { index: 2, part: labelPart() });
    expect(updated).not.toBe(message);
    expect((updated.content as unknown[])[2]).toMatchObject({
      type: ContentTypes.ACTIVITY_LABEL,
      pending: true,
    });
  });

  it('returns the same reference on duplicate replay', () => {
    const part = labelPart({ activity_label: 'Searched docs', pending: false });
    const message = buildMessage([undefined as never, part as never]);
    const updated = applyActivityLabelPart(message, { index: 1, part });
    expect(updated).toBe(message);
  });

  it('applies a bounds-only update to a completed phase', () => {
    const existing = labelPart({ activity_label: 'Fixed the session', pending: false });
    Object.assign(existing, {
      activity_label_type: 'phase',
      activity_start_index: 0,
      activity_count: 2,
    });
    const incoming = { ...existing, activity_start_index: 1 };
    const message = buildMessage([existing as never]);

    const updated = applyActivityLabelPart(message, { index: 0, part: incoming });

    expect(updated).not.toBe(message);
    expect((updated.content as unknown[])[0]).toMatchObject({
      activity_start_index: 1,
      activity_count: 2,
    });
  });

  it('never lets a stale pending placeholder overwrite a resolved label', () => {
    const resolved = labelPart({
      activity_label: 'Searched runtime release notes',
      pending: false,
    });
    const message = buildMessage([resolved as never]);
    const updated = applyActivityLabelPart(message, {
      index: 0,
      part: labelPart({ pending: true }),
    });
    expect(updated).toBe(message);
    expect((updated.content as unknown[])[0]).toMatchObject({
      activity_label: 'Searched runtime release notes',
      pending: false,
    });
  });

  it('never lets a stale pending placeholder overwrite an empty finalized phase', () => {
    const finalized = labelPart({ pending: false });
    Object.assign(finalized, {
      activity_label_type: 'phase',
      activity_start_index: 0,
      activity_end_index: 2,
      activity_count: 2,
    });
    const message = buildMessage([finalized as never]);

    const updated = applyActivityLabelPart(message, {
      index: 0,
      part: labelPart({ pending: true }),
    });

    expect(updated).toBe(message);
    expect((updated.content as unknown[])[0]).toMatchObject({
      activity_label: '',
      activity_label_type: 'phase',
      pending: false,
    });
  });
});

describe('lastVisibleContentIdx', () => {
  const text = { type: ContentTypes.TEXT, text: 'hello' } as unknown as TMessageContentParts;
  const tool = {
    type: ContentTypes.TOOL_CALL,
    [ContentTypes.TOOL_CALL]: { id: 't1', name: 'web_search', args: '{}', output: 'ok' },
  } as unknown as TMessageContentParts;

  it('skips a trailing blank label reservation', () => {
    expect(lastVisibleContentIdx([text, tool, labelPart() as never])).toBe(1);
  });

  it('skips consecutive trailing blank labels', () => {
    expect(lastVisibleContentIdx([tool, labelPart() as never, tool, labelPart() as never])).toBe(2);
  });

  it('counts a filled label as visible', () => {
    const filled = labelPart({ activity_label: 'Fetched the docs', pending: false });
    expect(lastVisibleContentIdx([tool, filled as never])).toBe(1);
  });

  it('falls back to the raw last index without labels', () => {
    expect(lastVisibleContentIdx([text, tool])).toBe(1);
    expect(lastVisibleContentIdx([])).toBe(-1);
    expect(lastVisibleContentIdx(undefined)).toBe(-1);
  });

  it('skips large sparse trailing gaps', () => {
    expect(lastVisibleContentIdx([undefined, tool, undefined, undefined])).toBe(1);
    const sparse = new Array<TMessageContentParts | undefined>(10_000);
    sparse[1] = tool;
    expect(lastVisibleContentIdx(sparse)).toBe(1);
  });

  it('keeps sparse late-label adoption bounded to defined slots', () => {
    const sparse = new Array<TMessageContentParts | undefined>(10_000);
    sparse[0] = tool;
    sparse[9_998] = labelPart({
      activity_label: 'Recorded the delayed result',
      pending: false,
    }) as never;
    const phase = labelPart({ activity_label: 'Completed the investigation', pending: false });
    Object.assign(phase, {
      activity_label_type: 'phase',
      activity_start_index: 0,
      activity_end_index: 1,
      activity_count: 2,
    });
    sparse[9_999] = phase as never;

    expect(lastVisibleContentIdx(sparse)).toBe(9_999);
  });

  it('keeps an appended phase marker as the visible tail when its final slot is empty', () => {
    const phase = labelPart({ activity_label: 'Completed the investigation', pending: false });
    Object.assign(phase, {
      activity_label_type: 'phase',
      activity_start_index: 0,
      activity_end_index: 1,
      activity_count: 2,
    });
    const emptyText = { type: ContentTypes.TEXT, text: '' } as TMessageContentParts;

    expect(lastVisibleContentIdx([tool, emptyText, phase as never])).toBe(2);
  });

  it('keeps the phase marker visible when an adopted late label follows an empty final slot', () => {
    const child = labelPart({ activity_label: 'Recorded the delayed result', pending: false });
    const phase = labelPart({ activity_label: 'Completed the investigation', pending: false });
    Object.assign(phase, {
      activity_label_type: 'phase',
      activity_start_index: 0,
      activity_end_index: 1,
      activity_count: 2,
    });
    const emptyText = { type: ContentTypes.TEXT, text: '' } as TMessageContentParts;

    expect(lastVisibleContentIdx([tool, emptyText, child as never, phase as never])).toBe(3);
  });
});

describe('lastCursorContentIdx', () => {
  it('keeps the cursor on visible output before a trailing empty provider placeholder', () => {
    const text = { type: ContentTypes.TEXT, text: 'Visible answer' } as TMessageContentParts;
    const emptyText = { type: ContentTypes.TEXT, text: '' } as TMessageContentParts;

    expect(lastCursorContentIdx([text, emptyText])).toBe(0);
  });

  it('retains a solitary empty placeholder for the initial waiting state', () => {
    const emptyText = { type: ContentTypes.TEXT, text: '' } as TMessageContentParts;

    expect(lastCursorContentIdx([emptyText])).toBe(0);
  });

  it('retains a sparse empty placeholder when no visible output precedes it', () => {
    const emptyText = { type: ContentTypes.TEXT, text: '' } as TMessageContentParts;

    expect(lastCursorContentIdx([undefined, emptyText])).toBe(1);
  });
});

describe('offsetActivityPhaseBoundary', () => {
  it('folds only boundaries covered by the merged first completion part', () => {
    expect(offsetActivityPhaseBoundary(0, 5, true)).toBe(4);
    expect(offsetActivityPhaseBoundary(1, 5, true)).toBe(5);
    expect(offsetActivityPhaseBoundary(3, 5, true)).toBe(8);
    expect(offsetActivityPhaseBoundary(3, 5, false)).toBe(8);
  });
});

describe('groupActivityPhases', () => {
  const text = { type: ContentTypes.TEXT, text: 'final answer' } as TMessageContentParts;
  const tool = {
    type: ContentTypes.TOOL_CALL,
    tool_call: { id: 't1', name: 'web_search', args: '{}', output: 'ok' },
  } as unknown as TMessageContentParts;

  it('carries absolute offsets while consuming a completed parent marker', () => {
    const phase = labelPart({ activity_label: 'Compared both release paths', pending: false });
    Object.assign(phase, {
      activity_label_type: 'phase',
      activity_start_index: 1,
      activity_count: 2,
    });
    const segments = groupActivityPhases([text, tool, tool, phase as never, text]);
    expect(segments).toHaveLength(3);
    expect(segments?.[1]).toMatchObject({ type: 'phase', labelIndex: 3, startIndex: 1 });
    if (segments?.[1]?.type === 'phase') {
      expect(segments[1].content).toEqual([tool, tool]);
    }
  });

  it('renders an appended parent marker before the final text using its explicit end', () => {
    const phase = labelPart({ activity_label: 'Completed the full investigation', pending: false });
    Object.assign(phase, {
      activity_label_type: 'phase',
      activity_start_index: 0,
      activity_end_index: 2,
      activity_count: 2,
    });
    const final = { type: ContentTypes.TEXT, text: 'Final answer' } as TMessageContentParts;
    const segments = groupActivityPhases([tool, tool, final, phase as never]);

    expect(segments).toHaveLength(2);
    expect(segments?.[0]).toMatchObject({
      type: 'phase',
      labelIndex: 3,
      startIndex: 0,
      content: [tool, tool],
    });
    expect(segments?.[1]).toMatchObject({
      type: 'content',
      startIndex: 2,
      content: [final],
    });
    expect(lastVisibleContentIdx([tool, tool, final, phase as never])).toBe(2);
  });

  it('keeps an emptied earlier phase header when a later marker recovers nothing', () => {
    const laterTool = {
      type: ContentTypes.TOOL_CALL,
      tool_call: { id: 'later', name: 'web_search', args: '{}', output: 'ok' },
    } as unknown as TMessageContentParts;
    /** Compaction left this completed phase with no children, so its summary
     *  header is the entire segment. A later marker recovers nothing from it. */
    const emptied = labelPart({ activity_label: 'Completed the compacted phase', pending: false });
    Object.assign(emptied, {
      activity_label_type: 'phase',
      activity_start_index: 0,
      activity_end_index: 0,
      activity_count: 2,
    });
    const later = labelPart({ activity_label: 'Completed the later phase', pending: false });
    Object.assign(later, {
      activity_label_type: 'phase',
      activity_start_index: 0,
      activity_end_index: 2,
      activity_count: 2,
    });
    const content = [emptied as never, laterTool, later as never];

    const segments = groupActivityPhases(content);

    expect(segments?.filter((segment) => segment.type === 'phase')).toHaveLength(2);
  });

  it('groups multiple logical spans when an earlier phase marker arrives late', () => {
    const first = labelPart({ activity_label: 'Completed the first phase', pending: false });
    Object.assign(first, {
      activity_label_type: 'phase',
      activity_start_index: 0,
      activity_end_index: 2,
      activity_count: 2,
    });
    const second = labelPart({ activity_label: 'Completed the second phase', pending: false });
    Object.assign(second, {
      activity_label_type: 'phase',
      activity_start_index: 3,
      activity_end_index: 6,
      activity_count: 2,
    });
    const boundary = {
      type: ContentTypes.TEXT,
      text: 'Substantial result',
    } as TMessageContentParts;
    const final = { type: ContentTypes.TEXT, text: 'Final result' } as TMessageContentParts;
    const content = [tool, tool, boundary, tool, first as never, tool, final, second as never];

    const segments = groupActivityPhases(content);

    expect(segments).toEqual([
      expect.objectContaining({
        type: 'phase',
        startIndex: 0,
        labelIndex: 4,
        contentIndices: [0, 1],
      }),
      expect.objectContaining({
        type: 'content',
        startIndex: 2,
        contentIndices: [2],
      }),
      expect.objectContaining({
        type: 'phase',
        startIndex: 3,
        labelIndex: 7,
        contentIndices: [3, 5],
      }),
      expect.objectContaining({
        type: 'content',
        startIndex: 6,
        contentIndices: [6],
      }),
    ]);
  });

  it('moves a late child label from an earlier phase into its declared later span', () => {
    const firstTool = {
      type: ContentTypes.TOOL_CALL,
      tool_call: { id: 'first', name: 'web_search', args: '{}', output: 'ok' },
    } as unknown as TMessageContentParts;
    const laterTool = {
      type: ContentTypes.TOOL_CALL,
      tool_call: { id: 'later', name: 'web_search', args: '{}', output: 'ok' },
    } as unknown as TMessageContentParts;
    const lateChild = labelPart({
      activity_label: 'Recorded the later result',
      pending: false,
      tool_call_ids: ['later'],
    });
    const first = labelPart({ activity_label: 'Completed the first phase', pending: false });
    Object.assign(first, {
      activity_label_type: 'phase',
      activity_start_index: 0,
      activity_end_index: 1,
      activity_count: 2,
    });
    const second = labelPart({ activity_label: 'Completed the second phase', pending: false });
    Object.assign(second, {
      activity_label_type: 'phase',
      activity_start_index: 2,
      activity_end_index: 4,
      activity_count: 2,
    });
    const boundary = { type: ContentTypes.TEXT, text: 'Boundary' } as TMessageContentParts;
    const content = [
      firstTool,
      boundary,
      laterTool,
      lateChild as never,
      first as never,
      second as never,
    ];

    const segments = groupActivityPhases(content);

    expect(segments).toEqual([
      expect.objectContaining({
        type: 'phase',
        labelIndex: 4,
        contentIndices: [0],
      }),
      expect.objectContaining({
        type: 'content',
        contentIndices: [1],
      }),
      expect.objectContaining({
        type: 'phase',
        labelIndex: 5,
        contentIndices: [2, 3],
      }),
    ]);
  });

  it('keeps a late child label in the phase while leaving final text outside', () => {
    const child = labelPart({
      activity_label: 'Recorded the delayed child result',
      pending: false,
      tool_call_ids: ['t1'],
    });
    const phase = labelPart({ activity_label: 'Completed the investigation', pending: false });
    Object.assign(phase, {
      activity_label_type: 'phase',
      activity_start_index: 0,
      activity_end_index: 1,
      activity_count: 2,
    });
    const final = { type: ContentTypes.TEXT, text: 'Final answer' } as TMessageContentParts;
    const content = [tool, final, child as never, phase as never];

    const segments = groupActivityPhases(content);

    expect(segments).toHaveLength(2);
    expect(segments?.[0]).toMatchObject({
      type: 'phase',
      startIndex: 0,
      content: [tool, child],
      contentIndices: [0, 2],
    });
    expect(segments?.[1]).toMatchObject({
      type: 'content',
      startIndex: 1,
      content: [final],
      contentIndices: [1],
    });
    expect(lastVisibleContentIdx(content)).toBe(1);
  });

  it('groups a sparse late child label without walking the empty range', () => {
    const content = new Array<TMessageContentParts | undefined>(10_000);
    const child = labelPart({ activity_label: 'Recorded the delayed result', pending: false });
    const phase = labelPart({
      activity_label: 'Completed the sparse investigation',
      pending: false,
    });
    Object.assign(phase, {
      activity_label_type: 'phase',
      activity_start_index: 0,
      activity_end_index: 1,
      activity_count: 2,
    });
    content[0] = tool;
    content[9_998] = child as never;
    content[9_999] = phase as never;

    const segments = groupActivityPhases(content);

    expect(segments?.[0]).toMatchObject({
      type: 'phase',
      startIndex: 0,
      labelIndex: 9_999,
    });
    if (segments?.[0]?.type === 'phase') {
      expect(segments[0].content[0]).toBe(tool);
      expect(segments[0].content[1]).toBe(child);
      expect(segments[0].contentIndices).toEqual([0, 9_998]);
      expect(segments[0].content).toHaveLength(2);
    }
  });

  it('restores a late child label when the parent label resolves empty', () => {
    const child = labelPart({
      activity_label: 'Recorded the delayed child result',
      pending: false,
      tool_call_ids: ['t1'],
    });
    const phase = labelPart({ pending: false });
    Object.assign(phase, {
      activity_label_type: 'phase',
      activity_start_index: 0,
      activity_end_index: 1,
      activity_count: 2,
    });
    const final = { type: ContentTypes.TEXT, text: 'Final answer' } as TMessageContentParts;
    const content = [tool, final, child as never, phase as never];

    const segments = groupActivityPhases(content);

    expect(segments).toEqual([
      expect.objectContaining({
        type: 'content',
        startIndex: 0,
        content: [tool, child],
        contentIndices: [0, 2],
      }),
      expect.objectContaining({
        type: 'content',
        startIndex: 1,
        content: [final],
        contentIndices: [1],
      }),
    ]);
    expect(lastVisibleContentIdx(content)).toBe(1);
  });

  it('leaves pending or empty parent markers on the feature-off path', () => {
    const pending = labelPart();
    Object.assign(pending, { activity_label_type: 'phase', activity_start_index: 0 });
    expect(groupActivityPhases([tool, pending as never])).toBeUndefined();
  });

  it('preserves a completed summary when every phase child was filtered out', () => {
    const phase = labelPart({ activity_label: 'Reconciled both release paths', pending: false });
    Object.assign(phase, {
      activity_label_type: 'phase',
      activity_start_index: 0,
      activity_count: 2,
    });

    expect(groupActivityPhases([labelPart() as never, phase as never])).toEqual([
      expect.objectContaining({
        type: 'phase',
        labelIndex: 1,
        hasContent: false,
      }),
    ]);
  });
});

describe('groupActivityPhases — synthesized folds', () => {
  const toolPart = (id: string): TMessageContentParts =>
    ({
      type: ContentTypes.TOOL_CALL,
      tool_call: { id, name: 'web_search', args: '{}', output: 'ok' },
    }) as unknown as TMessageContentParts;

  const childLabel = (label: string, status?: string): TMessageContentParts =>
    labelPart({
      activity_label: label,
      pending: false,
      ...(status != null && { status }),
    } as Partial<TActivityLabelEvent['part']>) as unknown as TMessageContentParts;

  const answer = (value = 'Here is what I found.'): TMessageContentParts =>
    ({ type: ContentTypes.TEXT, text: value }) as TMessageContentParts;

  const commentary = (value: string): TMessageContentParts =>
    ({ type: ContentTypes.TEXT, text: value, phase: 'commentary' }) as TMessageContentParts;

  const thinking = (): TMessageContentParts =>
    ({ type: ContentTypes.THINK, think: 'weighing options' }) as unknown as TMessageContentParts;

  const foldOf = (segments: ReturnType<typeof groupActivityPhases>) => {
    const fold = segments?.find((segment) => segment.type === 'phase');
    return fold?.type === 'phase' ? fold : undefined;
  };

  it('folds a run of two labeled activity blocks into one card', () => {
    const segments = groupActivityPhases([
      toolPart('t1'),
      childLabel('Read the config'),
      toolPart('t2'),
      childLabel('Checked the callers'),
    ]);

    expect(segments).toHaveLength(1);
    expect(foldOf(segments)).toMatchObject({
      synthesized: true,
      startIndex: 0,
      labelIndex: 3,
      hasContent: true,
    });
    expect(getActivityLabelText(foldOf(segments)?.labelPart)).toBe('Checked the callers');
  });

  it('carries the newest filled child label as the ticker', () => {
    const segments = groupActivityPhases([
      toolPart('t1'),
      childLabel('Read the config'),
      toolPart('t2'),
      childLabel('Checked the callers'),
      toolPart('t3'),
      childLabel('Confirmed the fix'),
    ]);

    expect(getActivityLabelText(foldOf(segments)?.labelPart)).toBe('Confirmed the fix');
    expect(foldOf(segments)?.labelPart.activity_count).toBe(3);
  });

  it('leaves in-flight activity past the newest label outside the card', () => {
    const segments = groupActivityPhases([
      toolPart('t1'),
      childLabel('Read the config'),
      toolPart('t2'),
      childLabel('Checked the callers'),
      thinking(),
      toolPart('t3'),
    ]);

    expect(foldOf(segments)?.contentIndices).toEqual([0, 1, 2, 3]);
    expect(segments?.[1]).toMatchObject({ type: 'content', contentIndices: [4, 5] });
  });

  it('does not fold a single labeled block', () => {
    expect(
      groupActivityPhases([toolPart('t1'), toolPart('t2'), childLabel('Read both files')]),
    ).toBeUndefined();
  });

  it('does not fold unlabeled tool calls', () => {
    expect(groupActivityPhases([toolPart('t1'), toolPart('t2'), toolPart('t3')])).toBeUndefined();
  });

  it('stops a fold at the answer text so it can never be hidden', () => {
    const segments = groupActivityPhases([
      toolPart('t1'),
      childLabel('Read the config'),
      toolPart('t2'),
      childLabel('Checked the callers'),
      answer('Done.'),
    ]);

    expect(foldOf(segments)?.contentIndices).toEqual([0, 1, 2, 3]);
    expect(segments?.[1]).toMatchObject({ type: 'content', contentIndices: [4] });
  });

  it('absorbs short commentary but breaks on a substantial block', () => {
    const short = groupActivityPhases([
      commentary('One moment.'),
      toolPart('t1'),
      childLabel('Read the config'),
      toolPart('t2'),
      childLabel('Checked the callers'),
    ]);
    expect(foldOf(short)?.contentIndices).toEqual([0, 1, 2, 3, 4]);

    const long = groupActivityPhases([
      commentary('x'.repeat(201)),
      toolPart('t1'),
      childLabel('Read the config'),
      toolPart('t2'),
      childLabel('Checked the callers'),
    ]);
    expect(foldOf(long)?.contentIndices).toEqual([1, 2, 3, 4]);
  });

  it('aggregates child status onto the card', () => {
    const partial = groupActivityPhases([
      toolPart('t1'),
      childLabel('Read the config', 'failed'),
      toolPart('t2'),
      childLabel('Checked the callers'),
    ]);
    expect(foldOf(partial)?.labelPart.status).toBe('partial');

    const failed = groupActivityPhases([
      toolPart('t1'),
      childLabel('Read the config', 'failed'),
      toolPart('t2'),
      childLabel('Checked the callers', 'failed'),
    ]);
    expect(foldOf(failed)?.labelPart.status).toBe('failed');
  });

  const inLane = (part: TMessageContentParts, agentId: string): TMessageContentParts =>
    ({ ...(part as object), agentId, groupId: 1 }) as unknown as TMessageContentParts;

  it('stands down when the message carries parallel content', () => {
    expect(
      groupActivityPhases([
        inLane(toolPart('t1'), 'agent_a'),
        inLane(childLabel('Read the config'), 'agent_a'),
        inLane(toolPart('t2'), 'agent_b'),
        inLane(childLabel('Checked the callers'), 'agent_b'),
      ]),
    ).toBeUndefined();
  });

  it('folds a labeled run whose group id is backed by one agent', () => {
    /** A multi-agent graph stamps a group id on every starting node, so an
     *  agent that merely has subagents available carries one on its own
     *  output. It renders sequentially, so it folds like any other run. */
    const segments = groupActivityPhases([
      inLane(toolPart('t1'), 'agent_a'),
      inLane(childLabel('Read the config'), 'agent_a'),
      inLane(toolPart('t2'), 'agent_a'),
      inLane(childLabel('Checked the callers'), 'agent_a'),
    ]);

    expect(foldOf(segments)).toMatchObject({ synthesized: true, contentIndices: [0, 1, 2, 3] });
  });

  it("takes the caller's lane scan instead of repeating it", () => {
    /** `ContentParts` already scans the message for lanes; passing the answer
     *  keeps a streamed delta to one pass, and must decide identically. */
    const run = [
      inLane(toolPart('t1'), 'agent_a'),
      inLane(childLabel('Read the config'), 'agent_a'),
      inLane(toolPart('t2'), 'agent_a'),
      inLane(childLabel('Checked the callers'), 'agent_a'),
    ];

    expect(foldOf(groupActivityPhases(run, new Set()))).toMatchObject({ synthesized: true });
    expect(groupActivityPhases(run, new Set([1]))).toBeUndefined();
  });

  it('never folds a span a server marker already claims', () => {
    const phase = labelPart({ activity_label: 'Reviewed the release paths', pending: false });
    Object.assign(phase, {
      activity_label_type: 'phase',
      activity_start_index: 0,
      activity_end_index: 4,
      activity_count: 2,
    });

    const segments = groupActivityPhases([
      toolPart('t1'),
      childLabel('Read the config'),
      toolPart('t2'),
      childLabel('Checked the callers'),
      phase as never,
    ]);

    expect(segments).toHaveLength(1);
    expect(segments?.[0]).toMatchObject({ type: 'phase', labelIndex: 4 });
    expect(segments?.[0]).not.toHaveProperty('synthesized', true);
  });

  it('folds a trailing run left unclaimed after a server phase', () => {
    const phase = labelPart({ activity_label: 'Reviewed the release paths', pending: false });
    Object.assign(phase, {
      activity_label_type: 'phase',
      activity_start_index: 0,
      activity_end_index: 2,
      activity_count: 2,
    });

    const segments = groupActivityPhases([
      toolPart('t1'),
      childLabel('Read the config'),
      phase as never,
      toolPart('t2'),
      childLabel('Checked the callers'),
      toolPart('t3'),
      childLabel('Confirmed the fix'),
    ]);

    const synthesized = segments?.filter(
      (segment) => segment.type === 'phase' && segment.synthesized === true,
    );
    expect(synthesized).toHaveLength(1);
    expect(synthesized?.[0]).toMatchObject({ startIndex: 3 });
  });
});

describe('groupActivityPhases — what a fold may not swallow', () => {
  const toolPart = (id: string, name = 'web_search'): TMessageContentParts =>
    ({
      type: ContentTypes.TOOL_CALL,
      tool_call: { id, name, args: '{}', output: 'ok' },
    }) as unknown as TMessageContentParts;

  const childLabel = (label: string): TMessageContentParts =>
    labelPart({ activity_label: label, pending: false }) as unknown as TMessageContentParts;

  const foldOf = (segments: ReturnType<typeof groupActivityPhases>) => {
    const fold = segments?.find((segment) => segment.type === 'phase');
    return fold?.type === 'phase' ? fold : undefined;
  };

  it('breaks the fold on a visible non-activity part', () => {
    const error = { type: ContentTypes.ERROR, error: 'boom' } as unknown as TMessageContentParts;
    const segments = groupActivityPhases([
      toolPart('t1'),
      childLabel('Read the config'),
      error,
      toolPart('t2'),
      childLabel('Checked the callers'),
    ]);

    /** One activity either side of the error, so neither side reaches the
     *  threshold — the error cannot end up behind a tool disclosure. */
    expect(segments).toBeUndefined();
  });

  it('keeps a handoff inside the fold, matching the server', () => {
    const handoff = {
      type: ContentTypes.AGENT_UPDATE,
      agent_update: { agentId: 'agent_2' },
    } as unknown as TMessageContentParts;
    const segments = groupActivityPhases([
      toolPart('t1'),
      childLabel('Read the config'),
      handoff,
      toolPart('t2'),
      childLabel('Checked the callers'),
    ]);

    expect(foldOf(segments)?.contentIndices).toEqual([0, 1, 2, 3, 4]);
  });

  it('does not count orphan labels that head no group', () => {
    expect(
      groupActivityPhases([childLabel('Read the config'), childLabel('Checked the callers')]),
    ).toBeUndefined();
  });

  it('does not count a label whose only call is a handoff', () => {
    const transfer = toolPart('t2', `${Constants.LC_TRANSFER_TO_}agent_2`);
    expect(
      groupActivityPhases([
        toolPart('t1'),
        childLabel('Read the config'),
        transfer,
        childLabel('Handed off'),
      ]),
    ).toBeUndefined();
  });

  it('does not let a handoff carry an earlier call into the next label', () => {
    /** `groupSequentialToolCalls` flushes the block at the non-groupable
     *  transfer and then drops the label through `coversTransferCall`, so
     *  neither batch heads a rendered group. */
    const batch = (index: number) => [
      toolPart(`t${index}a`),
      toolPart(`t${index}b`, `${Constants.LC_TRANSFER_TO_}agent_${index}`),
      childLabel(`Handed off ${index}`),
    ];

    expect(groupActivityPhases([...batch(1), ...batch(2)])).toBeUndefined();
  });

  it('resets the claim at a blank reservation, as the grouping does', () => {
    /** The blank label closes the first batch's claim, so the filled label
     *  after it claims nothing and heads no group. */
    expect(
      groupActivityPhases([
        toolPart('t1'),
        childLabel('Read the config'),
        toolPart('t2'),
        labelPart() as unknown as TMessageContentParts,
        childLabel('Checked the callers'),
      ]),
    ).toBeUndefined();
  });
});

describe('findActivityLabelMessageIndex', () => {
  const user: TMessage = { ...buildMessage([]), messageId: 'user-1', isCreatedByUser: true };
  const placeholder: TMessage = { ...buildMessage([]), messageId: 'user-1_' };
  const older: TMessage = { ...buildMessage([]), messageId: 'older-response' };
  const event = {
    index: 0,
    part: labelPart(),
    responseMessageId: 'server-resp',
  } as TActivityLabelEvent;

  it("falls back to the pane's own placeholder before the first run step renames it", () => {
    expect(findActivityLabelMessageIndex([user, placeholder], event, ['user-1_'])).toBe(1);
  });

  it('never guesses by position when the event names a row the pane has not rendered', () => {
    expect(findActivityLabelMessageIndex([user, older], event)).toBe(-1);
    expect(findActivityLabelMessageIndex([user, older], event, [undefined, null])).toBe(-1);
  });

  it('ignores a placeholder id that names a user message', () => {
    expect(findActivityLabelMessageIndex([user, older], event, ['user-1'])).toBe(-1);
  });
});

describe('groupActivityPhases — live tail', () => {
  const tool = (id: string, name = 'lookup'): TMessageContentParts =>
    ({
      type: ContentTypes.TOOL_CALL,
      [ContentTypes.TOOL_CALL]: { id, name, args: '{}', output: '' },
    }) as unknown as TMessageContentParts;
  const text = (value: string): TMessageContentParts =>
    ({ type: ContentTypes.TEXT, text: value }) as unknown as TMessageContentParts;
  const think = { type: ContentTypes.THINK, think: 'hm' } as unknown as TMessageContentParts;

  it('folds the span being written from its first tool call, tail included', () => {
    const segments = groupActivityPhases([think, tool('t1')], undefined, true);
    expect(segments).toHaveLength(1);
    expect(segments?.[0]).toMatchObject({
      type: 'phase',
      live: true,
      synthesized: true,
      contentIndices: [0, 1],
    });
  });

  it('leaves the same content untouched when the message is not live', () => {
    expect(groupActivityPhases([think, tool('t1')])).toBeUndefined();
  });

  it('folds a streaming thought before any tool call, so its peek never opens and snaps shut', () => {
    const segments = groupActivityPhases([think], undefined, true);
    expect(segments?.[0]).toMatchObject({ type: 'phase', live: true, contentIndices: [0] });
  });

  it('does not fold a thought that has no text yet', () => {
    const empty = { type: ContentTypes.THINK, think: '  ' } as unknown as TMessageContentParts;
    expect(groupActivityPhases([empty], undefined, true)).toBeUndefined();
  });

  it('leaves a settled thought on its own row', () => {
    expect(groupActivityPhases([think])).toBeUndefined();
  });

  it('does not fold a span the stream has already moved past', () => {
    expect(groupActivityPhases([tool('t1'), text('The answer.')], undefined, true)).toBeUndefined();
  });

  it('folds only the tail span when an answer separates two runs', () => {
    const segments = groupActivityPhases(
      [tool('t1'), text('A first answer.'), tool('t2')],
      undefined,
      true,
    );
    expect(segments?.map((segment) => segment.type)).toEqual(['content', 'phase']);
    expect(segments?.[1]).toMatchObject({ live: true, contentIndices: [2] });
  });

  it('never folds a handoff on its own', () => {
    const transfer = tool('t1', `${Constants.LC_TRANSFER_TO_}agent_b`);
    expect(groupActivityPhases([transfer], undefined, true)).toBeUndefined();
  });
});

describe('groupActivityPhases — live tail and handoffs', () => {
  const tool = (id: string, name = 'lookup'): TMessageContentParts =>
    ({
      type: ContentTypes.TOOL_CALL,
      [ContentTypes.TOOL_CALL]: { id, name, args: '{}', output: '' },
    }) as unknown as TMessageContentParts;

  it('ends the span at a handoff and starts a new live span for the next agent', () => {
    const transfer = tool('h1', `${Constants.LC_TRANSFER_TO_}agent_b`);
    const segments = groupActivityPhases([tool('t1'), transfer, tool('t2')], undefined, true);
    expect(segments?.map((segment) => segment.type)).toEqual(['content', 'phase']);
    expect(segments?.[0].contentIndices).toEqual([0, 1]);
    expect(segments?.[1]).toMatchObject({ live: true, contentIndices: [2] });
  });
});
