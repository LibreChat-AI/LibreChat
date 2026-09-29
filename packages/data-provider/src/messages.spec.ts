import type { SummaryContentPart } from './types/content';
import type { ParentMessage } from './messages';
import type { TFile } from './types/files';
import type { TMessage } from './types';
import { buildTree, findMessageById, isCompactedLeaf, isUserInitiatedCompaction } from './messages';
import { ContentTypes } from './types/runs';

const msg = (messageId: string, parentMessageId: string, over: Partial<TMessage> = {}): TMessage =>
  ({
    messageId,
    parentMessageId,
    conversationId: 'c1',
    text: '',
    isCreatedByUser: false,
    error: false,
    ...over,
  }) as TMessage;

const asParent = (node: TMessage | undefined): ParentMessage => node as ParentMessage;

describe('buildTree', () => {
  it('returns null for null input and [] for empty input', () => {
    expect(buildTree({ messages: null })).toBeNull();
    expect(buildTree({ messages: [] })).toEqual([]);
  });

  it('builds the standard tree from creation-ordered messages', () => {
    const tree = buildTree({
      messages: [
        msg('u1', '00000000-0000-0000-0000-000000000000', { isCreatedByUser: true }),
        msg('a1', 'u1'),
        msg('u2', 'a1', { isCreatedByUser: true }),
        msg('a2', 'u2'),
        msg('a2b', 'u2'),
      ],
    });

    expect(tree).toHaveLength(1);
    const root = asParent(tree?.[0]);
    expect(root.messageId).toBe('u1');
    expect(root.depth).toBe(0);
    const a1 = asParent(root.children[0]);
    expect(a1.messageId).toBe('a1');
    expect(a1.depth).toBe(1);
    const u2 = asParent(a1.children[0]);
    const siblings = u2.children.map((c) => asParent(c));
    expect(siblings.map((c) => c.messageId)).toEqual(['a2', 'a2b']);
    expect(siblings.map((c) => c.siblingIndex)).toEqual([0, 1]);
    expect(siblings.map((c) => c.depth)).toEqual([3, 3]);
  });

  it('nests a child that appears BEFORE its parent in the array', () => {
    const tree = buildTree({
      messages: [msg('a1', 'u1'), msg('u1', '00000000-0000-0000-0000-000000000000')],
    });

    expect(tree).toHaveLength(1);
    const root = asParent(tree?.[0]);
    expect(root.messageId).toBe('u1');
    const a1 = asParent(root.children[0]);
    expect(a1.messageId).toBe('a1');
    expect(a1.depth).toBe(1);
  });

  /**
   * Regression: the preempt-fold incident. Two abandoned (preempt-incomplete)
   * assistant siblings ended up ordered BEFORE their parent user message in
   * the cache after a resume finalize. The single-pass builder hoisted them to
   * phantom roots (while the sibling counter still read 3), folding the
   * visible thread to the latest branch until a refetch restored order.
   */
  it('keeps preempt-abandoned siblings nested when ordered before their parent', () => {
    const NO_PARENT = '00000000-0000-0000-0000-000000000000';
    const tree = buildTree({
      messages: [
        msg('user-1', NO_PARENT, { isCreatedByUser: true }),
        msg('assist-1', 'user-1'),
        msg('user-2', 'assist-1', { isCreatedByUser: true }),
        msg('assist-2', 'user-2', { unfinished: true }),
        msg('abandoned-1', 'user-3', { unfinished: true }),
        msg('abandoned-2', 'user-3', { unfinished: true }),
        msg('user-3', 'assist-2', { isCreatedByUser: true }),
        msg('assist-3', 'user-3'),
      ],
    });

    expect(tree).toHaveLength(1);
    expect(asParent(tree?.[0]).messageId).toBe('user-1');

    const assist2 = asParent(
      asParent(asParent(asParent(tree?.[0]).children[0]).children[0]).children[0],
    );
    expect(assist2.messageId).toBe('assist-2');
    const user3 = asParent(assist2.children[0]);
    expect(user3.messageId).toBe('user-3');
    expect(user3.depth).toBe(4);

    const siblings = user3.children.map((c) => asParent(c));
    expect(siblings.map((c) => c.messageId)).toEqual(['abandoned-1', 'abandoned-2', 'assist-3']);
    expect(siblings.map((c) => c.siblingIndex)).toEqual([0, 1, 2]);
    expect(siblings.map((c) => c.depth)).toEqual([5, 5, 5]);
  });

  it('surfaces a corrupt parent cycle as a root and severs the back-edge', () => {
    const tree = buildTree({
      messages: [msg('u1', '00000000-0000-0000-0000-000000000000'), msg('x', 'y'), msg('y', 'x')],
    });

    const rootIds = tree?.map((node) => node.messageId);
    expect(rootIds).toContain('u1');
    expect(rootIds).toContain('x');
    const cycleRoot = asParent(tree?.find((node) => node.messageId === 'x'));
    const y = asParent(cycleRoot.children[0]);
    expect(y.messageId).toBe('y');
    expect(y.depth).toBe(1);
    /** The returned structure must be acyclic: recursive consumers
     *  (MultiMessage, branch utilities) walk `children` unguarded. */
    expect(y.children).toEqual([]);
  });

  it('treats a self-parented message as a root without inflating child sibling indices', () => {
    const tree = buildTree({ messages: [msg('loop', 'loop'), msg('a', 'loop'), msg('b', 'loop')] });

    expect(tree).toHaveLength(1);
    const root = asParent(tree?.[0]);
    expect(root.messageId).toBe('loop');
    /** The rejected self-edge must not be charged to `loop`'s child count:
     *  sibling indices stay within `children.length`. */
    const children = root.children.map((c) => asParent(c));
    expect(children.map((c) => c.messageId)).toEqual(['a', 'b']);
    expect(children.map((c) => c.siblingIndex)).toEqual([0, 1]);
  });

  it('maps files through fileMap and skips undefined entries', () => {
    const file = { file_id: 'f1', filename: 'hydrated.png' } as TFile;
    const tree = buildTree({
      messages: [
        undefined,
        msg('u1', '00000000-0000-0000-0000-000000000000', {
          files: [{ file_id: 'f1', filename: 'stub.png' }],
        }),
      ],
      fileMap: { f1: file },
    });

    expect(tree).toHaveLength(1);
    expect(tree?.[0].files?.[0]).toBe(file);
  });

  describe('memoization', () => {
    const chain = () => [
      msg('u1', '00000000-0000-0000-0000-000000000000', { isCreatedByUser: true }),
      msg('a1', 'u1'),
    ];

    it('returns the identical tree for the same messages array', () => {
      const messages = chain();
      expect(buildTree({ messages })).toBe(buildTree({ messages }));
    });

    it('keeps one cached tree per fileMap identity', () => {
      const messages = chain();
      const fileMap = { f1: { file_id: 'f1' } as TFile };

      const bare = buildTree({ messages });
      const hydrated = buildTree({ messages, fileMap });

      expect(hydrated).not.toBe(bare);
      expect(buildTree({ messages })).toBe(bare);
      expect(buildTree({ messages, fileMap })).toBe(hydrated);
    });

    it('rebuilds for a new messages array identity', () => {
      const first = chain();
      const second = chain();
      expect(buildTree({ messages: first })).not.toBe(buildTree({ messages: second }));
    });

    it('rebuilds when the fileMap identity changes', () => {
      const messages = chain();
      const treeA = buildTree({ messages, fileMap: {} });
      const treeB = buildTree({ messages, fileMap: {} });
      expect(treeB).not.toBe(treeA);
    });

    it('keeps only the latest hydrated tree, leaving the bare slot intact', () => {
      const messages = chain();
      const bare = buildTree({ messages });
      const fileMapA = { f1: { file_id: 'f1' } as TFile };
      const fileMapB = { f1: { file_id: 'f1' } as TFile };

      const treeA = buildTree({ messages, fileMap: fileMapA });
      const treeB = buildTree({ messages, fileMap: fileMapB });

      expect(buildTree({ messages, fileMap: fileMapB })).toBe(treeB);
      expect(buildTree({ messages, fileMap: fileMapA })).not.toBe(treeA);
      expect(buildTree({ messages })).toBe(bare);
    });
  });
});

describe('isCompactedLeaf', () => {
  const summary = (overrides: Record<string, unknown> = {}) => ({
    type: ContentTypes.SUMMARY,
    content: [{ type: ContentTypes.TEXT, text: 'checkpoint' }],
    boundary: { messageId: 'step_summary', contentIndex: 0 },
    ...overrides,
  });

  it('is true for a bare, finished summary', () => {
    expect(isCompactedLeaf({ content: [summary()] } as TMessage)).toBe(true);
  });

  it.each([
    ['no content', undefined],
    ['empty content', []],
    ['a summary next to text', [summary(), { type: ContentTypes.TEXT, text: 'reply' }]],
    ['a summary still streaming', [summary({ summarizing: true })]],
    ['a failed summary', [summary({ failed: true })]],
    ['a streamed summary that never recorded a boundary', [summary({ boundary: undefined })]],
    ['an empty summary', [summary({ content: [] })]],
  ])('is false for %s', (_label, content) => {
    expect(isCompactedLeaf({ content } as TMessage)).toBe(false);
  });
});

describe('findMessageById', () => {
  const thread = () => [
    msg('u1', '00000000-0000-0000-0000-000000000000', { isCreatedByUser: true }),
    msg('a1', 'u1'),
  ];

  it('resolves a message by id and reports a missing one', () => {
    const messages = thread();
    expect(findMessageById(messages, 'a1')).toBe(messages[1]);
    expect(findMessageById(messages, 'absent')).toBeUndefined();
    expect(findMessageById(messages, null)).toBeUndefined();
    expect(findMessageById(null, 'a1')).toBeUndefined();
  });

  /** The index is memoized per array identity, and a cache write replaces the
   *  array. Answering a later lookup from the previous array's rows would hand
   *  the caller a message the thread no longer holds. */
  it('answers from the array it was given, not from a previous one', () => {
    const before = thread();
    expect(findMessageById(before, 'a1')).toBe(before[1]);

    const edited = { ...before[1], text: 'edited' };
    const after = [before[0], edited];

    expect(findMessageById(after, 'a1')).toBe(edited);
    expect(findMessageById(before, 'a1')).toBe(before[1]);
  });
});

describe('isUserInitiatedCompaction', () => {
  const summary = (overrides: Partial<SummaryContentPart> = {}): SummaryContentPart => ({
    type: ContentTypes.SUMMARY,
    content: [{ type: ContentTypes.TEXT, text: 'checkpoint' }],
    ...overrides,
  });

  it('is true for the summary a Compact action produced', () => {
    expect(
      isUserInitiatedCompaction({ content: [summary({ initiatedBy: 'user' })] } as TMessage),
    ).toBe(true);
  });

  /** A compaction that produced no summary marks its error part instead: that
   *  turn is still a compaction, whatever it hangs off. */
  it('is true for the failure a compaction recorded instead of a summary', () => {
    expect(
      isUserInitiatedCompaction({
        content: [{ type: ContentTypes.ERROR, error: 'failed', initiatedBy: 'user' }],
      } as TMessage),
    ).toBe(true);
  });

  /** An automatic summary detour carries no marker: that turn answers a user
   *  message and stays rerunnable. */
  it.each([
    ['an unmarked summary', [summary()]],
    ['an unmarked error part', [{ type: ContentTypes.ERROR, error: 'failed' }]],
    ['a plain answer', [{ type: ContentTypes.TEXT, text: 'reply' }]],
    ['no content', undefined],
  ])('is false for %s', (_label, content) => {
    expect(isUserInitiatedCompaction({ content } as TMessage)).toBe(false);
  });
});
