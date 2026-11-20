import { logger } from '@librechat/data-schemas';
import { Constants } from 'librechat-data-provider';

import type { LineageMessage } from './lineage';
import {
  cloneLineage,
  breakParentCycles,
  orderMessageLineage,
  orderParentTimestamps,
  getAllMessagesUpToParent,
} from './lineage';

const BASE = Date.UTC(2024, 0, 1);
const ROOT: string = Constants.NO_PARENT;

const at = (offset: number): Date => new Date(BASE + offset);

const message = (messageId: string, parentMessageId: string, offset = 0): LineageMessage => ({
  messageId,
  parentMessageId,
  createdAt: at(offset),
});

const timeOf = (messages: LineageMessage[], messageId: string): number =>
  messages.find((entry) => entry.messageId === messageId)?.createdAt.getTime() ?? Number.NaN;

/** Lists a chain deepest-first, the order that forces one pass per level on a naive fixed point. */
const reverseChain = (length: number): LineageMessage[] =>
  Array.from({ length }, (_, index) => {
    const depth = length - 1 - index;
    return message(`m${depth}`, depth === 0 ? Constants.NO_PARENT : `m${depth - 1}`);
  });

describe('breakParentCycles', () => {
  it('leaves a forest untouched', () => {
    const messages = [
      message('a', Constants.NO_PARENT),
      message('b', 'a'),
      message('c', 'a'),
      message('d', 'missing'),
    ];

    expect(breakParentCycles(messages)).toBe(false);
    expect(messages.map((entry) => entry.parentMessageId)).toEqual([
      Constants.NO_PARENT,
      'a',
      'a',
      'missing',
    ]);
  });

  it('severs the link that closes a two-message cycle', () => {
    const messages = [message('a', 'b'), message('b', 'a')];

    expect(breakParentCycles(messages)).toBe(true);
    expect(messages[0].parentMessageId).toBe(Constants.NO_PARENT);
    expect(messages[1].parentMessageId).toBe('a');
  });

  it('severs a self-parented message', () => {
    const messages = [message('a', 'a')];

    expect(breakParentCycles(messages)).toBe(true);
    expect(messages[0].parentMessageId).toBe(Constants.NO_PARENT);
  });

  it('keeps the tail that leads into a cycle attached to it', () => {
    const messages = [message('tail', 'a'), message('a', 'b'), message('b', 'a')];

    expect(breakParentCycles(messages)).toBe(true);
    expect(messages.map((entry) => entry.parentMessageId)).toEqual(['a', Constants.NO_PARENT, 'a']);
  });
});

describe('orderParentTimestamps', () => {
  it('moves a child that sorts at or before its parent to one millisecond after it', () => {
    const messages = [message('parent', Constants.NO_PARENT, 100), message('child', 'parent', 50)];

    orderParentTimestamps(messages);

    expect(timeOf(messages, 'child')).toBe(BASE + 101);
    expect(timeOf(messages, 'parent')).toBe(BASE + 100);
  });

  it('keeps a child that already sorts after its parent', () => {
    const messages = [message('parent', Constants.NO_PARENT, 100), message('child', 'parent', 500)];

    orderParentTimestamps(messages);

    expect(timeOf(messages, 'child')).toBe(BASE + 500);
  });

  it('cascades through descendants regardless of listing order', () => {
    const messages = [
      message('grandchild', 'child', 0),
      message('child', 'parent', 0),
      message('sibling', 'parent', 300),
      message('parent', Constants.NO_PARENT, 200),
    ];

    orderParentTimestamps(messages);

    expect(timeOf(messages, 'parent')).toBe(BASE + 200);
    expect(timeOf(messages, 'child')).toBe(BASE + 201);
    expect(timeOf(messages, 'grandchild')).toBe(BASE + 202);
    expect(timeOf(messages, 'sibling')).toBe(BASE + 300);
  });

  it('does not adjust a message whose parent is not in the set', () => {
    const messages = [message('orphan', 'missing', 0)];

    orderParentTimestamps(messages);

    expect(timeOf(messages, 'orphan')).toBe(BASE);
  });

  it('does not propagate from an invalid parent timestamp', () => {
    const parent = message('parent', Constants.NO_PARENT);
    parent.createdAt = new Date(Number.NaN);
    const messages = [parent, message('child', 'parent', 0)];

    orderParentTimestamps(messages);

    expect(timeOf(messages, 'child')).toBe(BASE);
  });

  it('orders a deep chain listed deepest-first in a single pass', () => {
    const length = 20_000;
    const messages = reverseChain(length);

    const startedAt = performance.now();
    orderParentTimestamps(messages);
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeLessThan(1000);
    expect(timeOf(messages, 'm0')).toBe(BASE);
    expect(timeOf(messages, `m${length - 1}`)).toBe(BASE + length - 1);
  });
});

describe('orderMessageLineage', () => {
  it('breaks cycles before ordering and reports them once', () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    const messages = [message('a', 'b', 10), message('b', 'a', 10), message('c', 'b', 0)];

    orderMessageLineage(messages);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cyclic parent relationships'));
    expect(messages.map((entry) => entry.parentMessageId)).toEqual([Constants.NO_PARENT, 'a', 'b']);
    expect(timeOf(messages, 'a')).toBe(BASE + 10);
    expect(timeOf(messages, 'b')).toBe(BASE + 11);
    expect(timeOf(messages, 'c')).toBe(BASE + 12);
    warn.mockRestore();
  });

  it('stays silent for an acyclic lineage', () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);

    orderMessageLineage(reverseChain(3));

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('cloneLineage', () => {
  const sequentialIds = () => {
    let next = 0;
    return () => `clone-${++next}`;
  };

  it('clones roots first and re-links each child to its parent clone', () => {
    const { entries, idMapping } = cloneLineage(
      [
        { messageId: 'child', parentMessageId: 'root', createdAt: '2024-01-01T00:00:05.000Z' },
        { messageId: 'root', parentMessageId: ROOT, createdAt: new Date(BASE) },
      ],
      sequentialIds(),
    );

    expect(entries.map((entry) => entry.source.messageId)).toEqual(['root', 'child']);
    expect(idMapping).toEqual(
      new Map([
        ['root', 'clone-1'],
        ['child', 'clone-2'],
      ]),
    );
    expect(entries[0].parentMessageId).toBe(Constants.NO_PARENT);
    expect(entries[1].parentMessageId).toBe('clone-1');
    expect(entries[1].createdAt.getTime()).toBe(BASE + 5000);
  });

  it('moves a clone that sorts at or before its parent clone to one millisecond after it', () => {
    const { entries } = cloneLineage(
      [
        { messageId: 'root', parentMessageId: ROOT, createdAt: at(100) },
        { messageId: 'child', parentMessageId: 'root', createdAt: at(100) },
        { messageId: 'grandchild', parentMessageId: 'child', createdAt: at(0) },
      ],
      sequentialIds(),
    );

    expect(entries.map((entry) => entry.createdAt.getTime())).toEqual([
      BASE + 100,
      BASE + 101,
      BASE + 102,
    ]);
  });

  it('preserves every parent link for every listing order of a branched conversation', () => {
    const sources = [
      message('root', ROOT, 100),
      message('parent', 'root', 100),
      message('child', 'parent', 0),
      message('sibling', 'root', 200),
      message('leaf', 'child', 0),
    ].map((source) => Object.freeze(source));
    const original = sources.map((source) => ({ ...source }));
    let checked = 0;
    const checkOrders = (prefix: LineageMessage[], remaining: LineageMessage[]): void => {
      if (remaining.length > 0) {
        for (let i = 0; i < remaining.length; i++) {
          checkOrders(
            [...prefix, remaining[i]],
            remaining.filter((_, index) => index !== i),
          );
        }
        return;
      }
      const { entries, idMapping } = cloneLineage(Object.freeze(prefix), sequentialIds());
      const byId = new Map(entries.map((entry) => [entry.messageId, entry]));
      expect(entries).toHaveLength(sources.length);
      expect(new Set(idMapping.values()).size).toBe(sources.length);
      for (const entry of entries) {
        const parent = entry.source.parentMessageId;
        expect(entry.messageId).not.toBe(entry.source.messageId);
        expect(entry.parentMessageId).toBe(parent === ROOT ? ROOT : idMapping.get(parent ?? ''));
        const parentEntry = byId.get(entry.parentMessageId);
        if (parentEntry) {
          expect(entry.createdAt.getTime()).toBeGreaterThan(parentEntry.createdAt.getTime());
        }
      }
      checked++;
    };

    checkOrders([], sources);

    expect(checked).toBe(120);
    expect(sources).toEqual(original);
  });

  it.each([undefined, null, '', 'missing'])(
    'roots a message whose parent is %p instead of leaving a sequential fallback',
    (parentMessageId) => {
      const { entries } = cloneLineage(
        [message('root', ROOT), { messageId: 'orphan', parentMessageId, createdAt: at(10) }],
        sequentialIds(),
      );

      expect(entries.map((entry) => entry.parentMessageId)).toEqual([ROOT, ROOT]);
    },
  );

  it.each([
    { sources: [message('a', 'a')] },
    { sources: [message('a', 'b'), message('b', 'a'), message('tail', 'a')] },
  ])('breaks cyclic clone links without changing their sources: %p', ({ sources }) => {
    const original = sources.map((source) => ({ ...source }));
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    const { entries } = cloneLineage(sources, sequentialIds());

    expect(entries).toHaveLength(sources.length);
    expect(entries.filter((entry) => entry.parentMessageId === ROOT)).toHaveLength(1);
    const byId = new Map(entries.map((entry) => [entry.messageId, entry]));
    for (const entry of entries) {
      const parent = byId.get(entry.parentMessageId);
      if (parent) {
        expect(entry.createdAt.getTime()).toBeGreaterThan(parent.createdAt.getTime());
      }
    }
    expect(sources).toEqual(original);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('clones a deep reverse-listed chain without recursion or quadratic walks', () => {
    const length = 20_000;
    const sources = reverseChain(length);
    const startedAt = performance.now();
    const { entries, idMapping } = cloneLineage(sources, sequentialIds());

    expect(performance.now() - startedAt).toBeLessThan(1000);
    expect(entries).toHaveLength(length);
    const leaf = entries.find((entry) => entry.source.messageId === `m${length - 1}`);
    expect(leaf?.createdAt.getTime()).toBe(BASE + length - 1);
    expect(leaf?.parentMessageId).toBe(idMapping.get(`m${length - 2}`));
    expect(sources.every((source) => source.createdAt.getTime() === BASE)).toBe(true);
  });

  it('clones an empty conversation', () => {
    expect(cloneLineage([], sequentialIds())).toEqual({ entries: [], idMapping: new Map() });
  });

  it('stamps a missing timestamp with the current time', () => {
    const before = Date.now();
    const { entries } = cloneLineage(
      [{ messageId: 'root', parentMessageId: ROOT }],
      sequentialIds(),
    );

    expect(entries[0].createdAt.getTime()).toBeGreaterThanOrEqual(before);
  });
});

describe('getAllMessagesUpToParent', () => {
  const tree = [
    { messageId: 'root', parentMessageId: ROOT },
    { messageId: 'a', parentMessageId: 'root' },
    { messageId: 'b', parentMessageId: 'root' },
    { messageId: 'a1', parentMessageId: 'a' },
    { messageId: 'a2', parentMessageId: 'a' },
    { messageId: 'a1x', parentMessageId: 'a1' },
    { messageId: 'b1', parentMessageId: 'b' },
  ];

  it('returns the path to the root with every sibling along it, but not the target children', () => {
    expect(getAllMessagesUpToParent(tree, 'a1').map((entry) => entry.messageId)).toEqual([
      'root',
      'a',
      'b',
      'a1',
      'a2',
    ]);
  });

  it('returns nothing for an unknown target and stops on a parent cycle', () => {
    expect(getAllMessagesUpToParent(tree, 'unknown')).toEqual([]);
    const cyclic = [
      { messageId: 'x', parentMessageId: 'y' },
      { messageId: 'y', parentMessageId: 'x' },
    ];
    expect(getAllMessagesUpToParent(cyclic, 'x').map((entry) => entry.messageId)).toEqual([
      'x',
      'y',
    ]);
  });

  it('walks a deep chain from its leaf in one pass', () => {
    const length = 100_000;
    const chain = Array.from({ length }, (_, index) => ({
      messageId: `m${index}`,
      parentMessageId: index === 0 ? ROOT : `m${index - 1}`,
    }));

    const startedAt = performance.now();
    const branch = getAllMessagesUpToParent(chain, `m${length - 1}`);
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeLessThan(1000);
    expect(branch).toHaveLength(length);
  });
});
