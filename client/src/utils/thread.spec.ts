import type { TFile, TMessage } from 'librechat-data-provider';
import {
  ROOT_KEY,
  buildThreadIndex,
  changedParentKeys,
  reconcileSiblingIdx,
  resolveThreadRows,
} from './thread';

const ROOT = '00000000-0000-0000-0000-000000000000';

function message(messageId: string, parentMessageId: string, text = messageId): TMessage {
  return {
    messageId,
    parentMessageId,
    conversationId: 'c',
    text,
    isCreatedByUser: messageId.startsWith('u'),
  } as TMessage;
}

/** u1 -> a1 -> u2 -> (a2-old, a2) ; a2 -> u3 */
function fixture(): TMessage[] {
  return [
    message('u1', ROOT),
    message('a1', 'u1'),
    message('u2', 'a1'),
    message('a2-old', 'u2'),
    message('a2', 'u2'),
    message('u3', 'a2'),
  ];
}

describe('buildThreadIndex', () => {
  it('indexes children in array order and lists branch points', () => {
    const index = buildThreadIndex(fixture());
    expect(index.children.get(ROOT_KEY)).toEqual(['u1']);
    expect(index.children.get('u2')).toEqual(['a2-old', 'a2']);
    expect(index.branchParentKeys).toEqual(['u2']);
  });

  it('is memoized per array identity', () => {
    const messages = fixture();
    expect(buildThreadIndex(messages)).toBe(buildThreadIndex(messages));
    expect(buildThreadIndex(messages)).not.toBe(buildThreadIndex(messages.slice()));
  });

  it('links a child that precedes its parent and roots an orphan', () => {
    const index = buildThreadIndex([
      message('a1', 'u1'),
      message('u1', ROOT),
      message('x', 'gone'),
    ]);
    expect(index.children.get('u1')).toEqual(['a1']);
    expect(index.children.get(ROOT_KEY)).toEqual(['u1', 'x']);
  });

  it('breaks a parent cycle by resurfacing it as a root', () => {
    const index = buildThreadIndex([message('p', 'q'), message('q', 'p')]);
    expect(index.children.get(ROOT_KEY)).toEqual(['p']);
    expect(index.children.get('p')).toEqual(['q']);
    expect(index.children.get('q')).toEqual([]);
    const rows = resolveThreadRows(index, 'c', () => 0, null);
    expect(rows.map((row) => row.source.messageId)).toEqual(['p', 'q']);
  });
});

describe('resolveThreadRows', () => {
  it('follows the newest sibling by default and reports tree fields', () => {
    const rows = resolveThreadRows(buildThreadIndex(fixture()), 'c', () => 0, null);
    expect(rows.map((row) => row.source.messageId)).toEqual(['u1', 'a1', 'u2', 'a2', 'u3']);
    expect(rows[3]).toMatchObject({ siblingIdx: 0, siblingCount: 2, depth: 3, childCount: 1 });
    expect(rows[3].message.depth).toBe(3);
    expect(rows[3].message.children?.length).toBe(1);
    expect(rows[2].parentKey).toBe('a1');
    expect(rows[0].parentKey).toBe('c');
  });

  it('switches a branch through the selection lookup', () => {
    const rows = resolveThreadRows(
      buildThreadIndex(fixture()),
      'c',
      (key) => (key === 'u2' ? 1 : 0),
      null,
    );
    expect(rows.map((row) => row.source.messageId)).toEqual(['u1', 'a1', 'u2', 'a2-old']);
  });

  it('reuses every untouched row across a streaming write and keeps the array when nothing changed', () => {
    const first = fixture();
    const index = buildThreadIndex(first);
    const rows = resolveThreadRows(index, 'c', () => 0, null);
    const streamed = first.map((m) => (m.messageId === 'u3' ? { ...m, text: 'u3 more' } : m));
    const next = resolveThreadRows(buildThreadIndex(streamed), 'c', () => 0, rows);
    expect(next).not.toBe(rows);
    expect(next.slice(0, 4)).toEqual(rows.slice(0, 4));
    expect(next[0]).toBe(rows[0]);
    expect(next[4]).not.toBe(rows[4]);
    expect(next[4].message.text).toBe('u3 more');
    const again = resolveThreadRows(buildThreadIndex(streamed.slice()), 'c', () => 0, next);
    expect(again).toBe(next);
  });
});

describe('resolveThreadRows with a file map', () => {
  it('hydrates files on the row while reusing the raw cache identity', () => {
    const withFile = { ...message('u1', ROOT), files: [{ file_id: 'f1' }] } as TMessage;
    const fileMap: Record<string, TFile> = {
      f1: { file_id: 'f1', filename: 'hydrated.txt' } as TFile,
    };
    const first = [withFile, message('a1', 'u1')];
    const rows = resolveThreadRows(buildThreadIndex(first, fileMap), 'c', () => 0, null);
    expect(rows[0].source).toBe(withFile);
    expect(rows[0].message.files?.[0]).toMatchObject({ filename: 'hydrated.txt' });
    const streamed = first.map((m) => (m.messageId === 'a1' ? { ...m, text: 'more' } : m));
    const next = resolveThreadRows(buildThreadIndex(streamed, fileMap), 'c', () => 0, rows);
    expect(next[0]).toBe(rows[0]);
    const remapped = resolveThreadRows(
      buildThreadIndex(streamed, { ...fileMap }),
      'c',
      () => 0,
      next,
    );
    expect(remapped[0]).not.toBe(next[0]);
  });
});

describe('reconcileSiblingIdx', () => {
  it('follows an appended newest sibling', () => {
    expect(reconcileSiblingIdx(['a', 'b'], ['a', 'b', 'c'], 1)).toBe(0);
    expect(reconcileSiblingIdx(['a', 'b'], ['a', 'b', 'c'], 0)).toBeNull();
  });

  it('keeps the viewed sibling through a re-key or reorder', () => {
    expect(reconcileSiblingIdx(['a', 'b', 'c'], ['a', 'b', 'c2'], 1)).toBeNull();
    expect(reconcileSiblingIdx(['a', 'b', 'c'], ['b', 'a', 'c'], 2)).toBe(1);
  });

  it('falls back to the newest when the viewed sibling vanished', () => {
    expect(reconcileSiblingIdx(['a', 'b', 'c'], ['b', 'c'], 2)).toBe(0);
  });

  it('clamps a stale index on a parent it has not seen', () => {
    expect(reconcileSiblingIdx(undefined, ['a'], 3)).toBe(0);
    expect(reconcileSiblingIdx(undefined, ['a', 'b'], 1)).toBeNull();
  });
});

describe('changedParentKeys', () => {
  it('reports only parents whose children list changed', () => {
    const before = buildThreadIndex(fixture());
    const after = buildThreadIndex([...fixture(), message('a3', 'u3')]);
    expect(changedParentKeys(before, after)).toEqual(['u3']);
    expect(changedParentKeys(null, before).length).toBe(before.children.size);
  });
});
