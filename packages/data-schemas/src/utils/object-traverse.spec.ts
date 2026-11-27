import type { TraverseContext } from './object-traverse';
import traverse from './object-traverse';

/** Collects the dotted leaf paths visited during a traversal. */
function collectLeafPaths(input: unknown): string[] {
  const paths: string[] = [];
  traverse(input).forEach(function (this: TraverseContext) {
    if (this.isLeaf && !this.isRoot) {
      paths.push(this.path.join('.'));
    }
  });
  return paths;
}

/** Counts every node (including the root) visited during a traversal. */
function countVisits(input: unknown, options?: { maxNodes?: number; maxDepth?: number }): number {
  let count = 0;
  traverse(input, options).forEach(function () {
    count++;
  });
  return count;
}

describe('object-traverse', () => {
  describe('correctness', () => {
    it('visits every leaf of a plain nested object', () => {
      const paths = collectLeafPaths({ a: 1, b: { c: 2, d: 3 } });
      expect(paths).toEqual(expect.arrayContaining(['a', 'b.c', 'b.d']));
    });

    it('traverses shared (non-circular) references that appear in multiple branches', () => {
      const shared = { secret: 'value' };
      const paths = collectLeafPaths({ a: shared, b: shared });

      expect(paths).toContain('a.secret');
      expect(paths).toContain('b.secret');
    });

    it('traverses an array containing the same object multiple times', () => {
      const shared = { value: 42 };
      expect(collectLeafPaths([shared, shared, shared])).toEqual(['0.value', '1.value', '2.value']);
    });

    it('invokes the callback for each occurrence of a shared reference', () => {
      const shared = { name: 'duplicate' };
      const visited: unknown[] = [];
      traverse({ first: shared, second: shared }).forEach(function (value: unknown) {
        visited.push(value);
      });

      expect(visited.filter((node) => node === shared)).toHaveLength(2);
    });

    it('does not treat a diamond-shaped (DAG) structure as circular', () => {
      const leaf = { v: 1 };
      const paths = collectLeafPaths({ left: { leaf }, right: { leaf } });

      expect(paths).toContain('left.leaf.v');
      expect(paths).toContain('right.leaf.v');
    });
  });

  describe('cycle safety', () => {
    it('does not infinitely recurse on a self-referential object', () => {
      const node: Record<string, unknown> = { id: 1 };
      node.self = node;

      const paths = collectLeafPaths(node);

      expect(paths).toContain('id');
      expect(paths).not.toContain('self.id');
    });

    it('does not infinitely recurse on a multi-node cycle', () => {
      const a: Record<string, unknown> = { name: 'a' };
      const b: Record<string, unknown> = { name: 'b' };
      a.next = b;
      b.prev = a;

      expect(() => countVisits(a)).not.toThrow();
      const paths = collectLeafPaths(a);
      expect(paths).toContain('name');
      expect(paths).toContain('next.name');
    });
  });

  describe('bounds', () => {
    it('caps total work via maxNodes on a fan-out DAG', () => {
      // A diamond chain has 2^depth root-to-leaf paths; without a bound this
      // would visit millions of nodes. The cap keeps it finite.
      let node: Record<string, unknown> = { leaf: 1 };
      for (let i = 0; i < 24; i++) {
        const child = node;
        node = { l: child, r: child };
      }

      expect(countVisits(node, { maxNodes: 5000 })).toBeLessThanOrEqual(5000);
    });

    it('stops descending past maxDepth, visiting deep nodes as leaves', () => {
      const deep = { a: { b: { c: { d: { e: 'too deep' } } } } };

      const leafLevels: number[] = [];
      traverse(deep, { maxDepth: 2 }).forEach(function (this: TraverseContext) {
        if (this.isLeaf) {
          leafLevels.push(this.level);
        }
      });

      expect(Math.max(...leafLevels)).toBe(2);
    });

    it('does not truncate ordinary objects under the default bounds', () => {
      // root, a, b, b.c, b.d, and the three array elements.
      expect(countVisits({ a: 1, b: { c: 2, d: [3, 4, 5] } })).toBe(8);
    });

    it('stops iterating array children once the node budget is exhausted', () => {
      let indexReads = 0;
      const big = Array.from({ length: 1000 }, (_, i) => ({ i }));
      const probed = new Proxy(big, {
        get(target, prop, receiver) {
          if (typeof prop === 'string' && /^\d+$/.test(prop)) {
            indexReads++;
          }
          return Reflect.get(target, prop, receiver);
        },
      });

      // The budget is spent on the root alone, so the child loop must break
      // before touching all 1000 elements (no O(n) work after the cap).
      countVisits(probed, { maxNodes: 1 });

      expect(indexReads).toBeLessThan(10);
    });
  });

  describe('mutation safety', () => {
    it('detects an ancestor cycle even when a callback replaces the node via update()', () => {
      const arr: unknown[] = [];
      arr.push(arr);

      let selfVisits = 0;
      traverse(arr, { maxDepth: 50 }).forEach(function (this: TraverseContext, value: unknown) {
        if (value === arr) {
          selfVisits++;
        }
        // Mimic the debug formatter, which rewrites array nodes in place.
        if (this.notLeaf && Array.isArray(value)) {
          this.update('[summary]');
        }
      });

      // The self-reference is skipped as a true cycle, not re-expanded per level.
      expect(selfVisits).toBe(1);
    });
  });
});
