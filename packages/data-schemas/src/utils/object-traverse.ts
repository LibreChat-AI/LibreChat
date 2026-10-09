/**
 * ESM-native object traversal utility
 * Simplified implementation focused on the forEach use case
 */

/**
 * Defensive bounds for traversal. Cycles are detected via the ancestor chain,
 * but a shared (non-circular) reference reachable through many paths can still
 * fan out super-linearly on a DAG. These caps keep traversal off the event loop
 * floor for pathological inputs (e.g. logging a deeply shared object) without
 * affecting normal use. Tune via the options argument to `traverse`.
 */
export interface TraverseOptions {
  /** Maximum number of nodes visited before traversal stops. */
  maxNodes?: number;
  /** Maximum depth descended; deeper nodes are visited as leaves, not expanded. */
  maxDepth?: number;
}

// Tuned for the sole consumer, the debug logger. Measured cost is ~140ns/node
// with the formatter callback, so ~2.5k nodes keeps one log under ~1ms even on
// slower prod hardware, while real log objects are ~25-30 nodes at depth 3-4 —
// ample headroom. maxNodes bounds fan-out (the cost lever); maxDepth bounds
// recursion/readability. Callers needing more override via the options argument.
const DEFAULT_MAX_NODES = 2_500;
const DEFAULT_MAX_DEPTH = 5;

export interface TraverseContext {
  node: unknown;
  path: (string | number)[];
  parent: TraverseContext | undefined;
  key: string | number | undefined;
  isLeaf: boolean;
  notLeaf: boolean;
  isRoot: boolean;
  notRoot: boolean;
  level: number;
  circular: TraverseContext | null;
  update: (value: unknown, stopHere?: boolean) => void;
  remove: () => void;
}

type ForEachCallback = (this: TraverseContext, value: unknown) => void;

// Type guards for proper typing
type TraversableObject = Record<string | number, unknown> | unknown[];

function isObject(value: unknown): value is TraversableObject {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  // Treat these built-in types as leaf nodes, not objects to traverse
  if (value instanceof Date) return false;
  if (value instanceof RegExp) return false;
  if (value instanceof Error) return false;
  if (value instanceof URL) return false;

  // Check for Buffer (Node.js)
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) return false;

  // Check for TypedArrays and ArrayBuffer
  if (ArrayBuffer.isView(value)) return false;
  if (value instanceof ArrayBuffer) return false;
  if (value instanceof SharedArrayBuffer) return false;

  // Check for other built-in types that shouldn't be traversed
  if (value instanceof Promise) return false;
  if (value instanceof WeakMap) return false;
  if (value instanceof WeakSet) return false;
  if (value instanceof Map) return false;
  if (value instanceof Set) return false;

  // Check if it's a primitive wrapper object
  const stringTag = Object.prototype.toString.call(value);
  if (
    stringTag === '[object Boolean]' ||
    stringTag === '[object Number]' ||
    stringTag === '[object String]'
  ) {
    return false;
  }

  return true;
}

// Helper to safely set a property on an object or array
function setProperty(obj: TraversableObject, key: string | number, value: unknown): void {
  if (Array.isArray(obj) && typeof key === 'number') {
    obj[key] = value;
  } else if (!Array.isArray(obj) && typeof key === 'string') {
    obj[key] = value;
  } else if (!Array.isArray(obj) && typeof key === 'number') {
    // Handle numeric keys on objects
    obj[key] = value;
  }
}

// Helper to safely delete a property from an object
function deleteProperty(obj: TraversableObject, key: string | number): void {
  if (Array.isArray(obj) && typeof key === 'number') {
    // For arrays, we should use splice, but this is handled in remove()
    // This function is only called for non-array deletion
    return;
  }

  if (!Array.isArray(obj)) {
    delete obj[key];
  }
}

function hasOwnEnumerable(node: TraversableObject): boolean {
  for (const key in node) {
    if (Object.prototype.hasOwnProperty.call(node, key)) {
      return true;
    }
  }
  return false;
}

function forEach(obj: unknown, callback: ForEachCallback, options?: TraverseOptions): void {
  const maxNodes = options?.maxNodes ?? DEFAULT_MAX_NODES;
  const maxDepth = options?.maxDepth ?? DEFAULT_MAX_DEPTH;
  let visitedCount = 0;
  // Original (never-mutated) node references for the current DFS path, paired
  // with their contexts. Cycle detection compares against these rather than
  // context.node, which a callback's update() can reassign.
  const ancestors: { node: TraversableObject; context: TraverseContext }[] = [];

  function findAncestorCycle(node: TraversableObject): TraverseContext | null {
    for (let i = ancestors.length - 1; i >= 0; i--) {
      if (ancestors[i].node === node) {
        return ancestors[i].context;
      }
    }
    return null;
  }

  function walk(node: unknown, path: (string | number)[] = [], parent?: TraverseContext): void {
    if (visitedCount >= maxNodes) {
      return; // Bound total work; stop once the node budget is exhausted.
    }

    // Detect cycles via the current DFS path's original node refs. A shared
    // (non-circular) reference appearing in multiple branches is traversed
    // independently; the node/depth caps keep a DAG of shared references from
    // fanning out unboundedly.
    let circular: TraverseContext | null = null;
    if (isObject(node)) {
      circular = findAncestorCycle(node);
      if (circular) {
        return; // Skip true cycles to avoid infinite recursion.
      }
    }

    const key = path.length > 0 ? path[path.length - 1] : undefined;
    const isRoot = path.length === 0;
    const level = path.length;
    const tooDeep = level >= maxDepth;

    // Determine if this is a leaf node
    const isLeaf =
      tooDeep ||
      !isObject(node) ||
      (Array.isArray(node) ? node.length === 0 : !hasOwnEnumerable(node));

    // Create context
    const context: TraverseContext = {
      node,
      path: [...path],
      parent,
      key,
      isLeaf,
      notLeaf: !isLeaf,
      isRoot,
      notRoot: !isRoot,
      level,
      circular,
      update(value: unknown) {
        if (!isRoot && parent && key !== undefined && isObject(parent.node)) {
          setProperty(parent.node, key, value);
        }
        this.node = value;
      },
      remove() {
        if (!isRoot && parent && key !== undefined && isObject(parent.node)) {
          if (Array.isArray(parent.node) && typeof key === 'number') {
            parent.node.splice(key, 1);
          } else {
            deleteProperty(parent.node, key);
          }
        }
      },
    };

    // Call the callback with the context
    visitedCount++;
    callback.call(context, node);

    // Traverse children within bounds, breaking as soon as the budget is spent
    // so a wide array/object can't incur O(n) work after the cap is reached.
    if (isObject(node) && !isLeaf) {
      ancestors.push({ node, context });
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) {
          if (visitedCount >= maxNodes) {
            break;
          }
          walk(node[i], [...path, i], context);
        }
      } else {
        for (const childKey in node) {
          if (!Object.prototype.hasOwnProperty.call(node, childKey)) {
            continue;
          }
          if (visitedCount >= maxNodes) {
            break;
          }
          walk(node[childKey], [...path, childKey], context);
        }
      }
      ancestors.pop();
    }
  }

  walk(obj);
}

// Main traverse function that returns an object with forEach method
export default function traverse(obj: unknown, options?: TraverseOptions) {
  return {
    forEach(callback: ForEachCallback): void {
      forEach(obj, callback, options);
    },
  };
}
