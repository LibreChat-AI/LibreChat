import { Constants } from 'librechat-data-provider';

import type { TreeNode } from './tree';
import { orderTree, indexById, breakCycles, enforceOrdering } from './tree';

function node(messageId: string, parentMessageId: string, seconds: number): TreeNode {
  return { messageId, parentMessageId, createdAt: new Date(seconds * 1000) };
}

function rootsOf(messages: TreeNode[]): TreeNode[] {
  return messages.filter((message) => message.parentMessageId === Constants.NO_PARENT);
}

describe('breakCycles', () => {
  it('leaves an acyclic chain untouched', () => {
    const messages = [node('a', Constants.NO_PARENT, 1), node('b', 'a', 2), node('c', 'b', 3)];

    breakCycles(messages, indexById(messages));

    expect(messages.map((m) => m.parentMessageId)).toEqual([Constants.NO_PARENT, 'a', 'b']);
  });

  it('breaks a two-message cycle', () => {
    const messages = [node('a', 'b', 1), node('b', 'a', 2)];

    breakCycles(messages, indexById(messages));

    expect(rootsOf(messages)).toHaveLength(1);
  });

  /** A `parent === self` check, or anything that only looks a hop or two back,
   * passes the two-message case and hangs here. */
  it('breaks a three-message cycle', () => {
    const messages = [node('a', 'c', 1), node('b', 'a', 2), node('c', 'b', 3)];

    breakCycles(messages, indexById(messages));

    expect(rootsOf(messages)).toHaveLength(1);
  });

  /** Only the message that closes the loop is rooted. A descendant hanging off
   * a cycle keeps its parent; severing it too would split one conversation
   * into two unrelated top-level threads. */
  it('roots the cycle itself, not a descendant visited first', () => {
    const messages = [node('d', 'a', 4), node('a', 'c', 1), node('b', 'a', 2), node('c', 'b', 3)];

    breakCycles(messages, indexById(messages));

    expect(messages.find((m) => m.messageId === 'd')?.parentMessageId).toBe('a');
    expect(rootsOf(messages)).toHaveLength(1);
  });

  it('terminates on a self-referencing message', () => {
    const messages = [node('a', 'a', 1)];

    breakCycles(messages, indexById(messages));

    expect(messages[0].parentMessageId).toBe(Constants.NO_PARENT);
  });

  it('stays linear on a deep chain', () => {
    const messages: TreeNode[] = [node('m0', Constants.NO_PARENT, 1)];
    for (let i = 1; i < 5000; i++) {
      messages.push(node(`m${i}`, `m${i - 1}`, i + 1));
    }

    const started = process.hrtime.bigint();
    breakCycles(messages, indexById(messages));
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    expect(rootsOf(messages)).toHaveLength(1);
    /** The per-message-Set form measured 1.06 s at this size. A generous bound
     * still fails it by an order of magnitude while staying stable on CI. */
    expect(elapsedMs).toBeLessThan(250);
  });
});

describe('enforceOrdering', () => {
  it('nudges a child past its parent', () => {
    const messages = [node('a', Constants.NO_PARENT, 100), node('b', 'a', 50)];

    enforceOrdering(messages, indexById(messages));

    expect(messages[1].createdAt.getTime()).toBe(messages[0].createdAt.getTime() + 1);
  });

  /** The BFS from roots exists so a grandchild is corrected against a parent
   * that was itself just corrected. A single non-BFS pass satisfies the
   * two-level case and leaves the grandchild behind its parent here. */
  it('cascades a correction down three levels', () => {
    const messages = [node('a', Constants.NO_PARENT, 100), node('b', 'a', 50), node('c', 'b', 60)];

    enforceOrdering(messages, indexById(messages));

    const [a, b, c] = messages;
    expect(b.createdAt.getTime()).toBeGreaterThan(a.createdAt.getTime());
    expect(c.createdAt.getTime()).toBeGreaterThan(b.createdAt.getTime());
  });

  it('walks a wide flat tree without quadratic queue removal', () => {
    const messages: TreeNode[] = [node('root', Constants.NO_PARENT, 1)];
    for (let i = 0; i < 20000; i++) {
      messages.push(node(`c${i}`, 'root', 0));
    }

    const started = process.hrtime.bigint();
    enforceOrdering(messages, indexById(messages));
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    expect(messages[1].createdAt.getTime()).toBe(messages[0].createdAt.getTime() + 1);
    expect(elapsedMs).toBeLessThan(500);
  });
});

describe('orderTree', () => {
  it('produces an acyclic, monotonically ordered tree in one call', () => {
    const messages = [node('a', 'c', 100), node('b', 'a', 50), node('c', 'b', 60)];

    orderTree(messages);

    const byId = indexById(messages);
    for (const message of messages) {
      if (message.parentMessageId === Constants.NO_PARENT) {
        continue;
      }
      const parent = byId.get(message.parentMessageId);
      expect(parent).toBeDefined();
      expect(message.createdAt.getTime()).toBeGreaterThan(parent?.createdAt.getTime() ?? 0);
    }
  });
});
