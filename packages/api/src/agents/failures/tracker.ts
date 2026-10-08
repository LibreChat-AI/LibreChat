const MAX_ERROR_GRAPH_NODES = 32;
const MAX_AGGREGATE_ENTRIES_INSPECTED = 32;

type ObjectLike = object | ((...args: never[]) => unknown);

export interface ModelErrorTrackerCallback {
  readonly name: 'librechat-upstream-model-error-tracker';
  readonly awaitHandlers: true;
  readonly handleLLMError: (error: unknown) => void;
}

export interface ModelErrorTracker {
  readonly callback: ModelErrorTrackerCallback;
  readonly getUpstreamModelError: (error: unknown) => object | null;
}

function isObjectLike(value: unknown): value is ObjectLike {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

function readProperty(value: ObjectLike, property: PropertyKey): unknown {
  try {
    return Reflect.get(value, property);
  } catch {
    return undefined;
  }
}

function isArray(value: unknown): value is unknown[] {
  try {
    return Array.isArray(value);
  } catch {
    return false;
  }
}

/**
 * Tracks errors observed at the chat-model callback boundary. Hosts consult
 * the tracker only after the complete graph rejects, so retries and fallbacks
 * that recover never classify an otherwise successful run as upstream.
 */
export function createModelErrorTracker(): ModelErrorTracker {
  const modelErrors = new WeakSet<object>();

  const callback: ModelErrorTrackerCallback = Object.freeze({
    name: 'librechat-upstream-model-error-tracker',
    awaitHandlers: true,
    handleLLMError(error: unknown) {
      if (isObjectLike(error)) {
        modelErrors.add(error);
      }
    },
  });

  const getUpstreamModelError = (error: unknown): object | null => {
    if (!isObjectLike(error)) {
      return null;
    }

    const pendingCauses: ObjectLike[] = [error];
    const pendingAggregates: ObjectLike[] = [];
    const queued = new WeakSet<object>([error]);
    let visitedCount = 0;
    let aggregateEntriesInspected = 0;

    while (
      (pendingCauses.length > 0 || pendingAggregates.length > 0) &&
      visitedCount < MAX_ERROR_GRAPH_NODES
    ) {
      const current = pendingCauses.pop() ?? pendingAggregates.pop();
      if (current == null) {
        continue;
      }
      visitedCount += 1;

      if (modelErrors.has(current)) {
        return current;
      }

      const cause = readProperty(current, 'cause');
      const errors = readProperty(current, 'errors');

      /** Aggregate entries use a secondary worklist, so even a maximally wide
       * aggregate cannot consume the node budget before the standard cause
       * chain is examined. */
      if (isArray(errors)) {
        const length = readProperty(errors, 'length');
        const boundedLength =
          typeof length === 'number' && Number.isSafeInteger(length) && length > 0
            ? Math.min(length, MAX_AGGREGATE_ENTRIES_INSPECTED)
            : 0;
        for (
          let index = boundedLength - 1;
          index >= 0 && aggregateEntriesInspected < MAX_AGGREGATE_ENTRIES_INSPECTED;
          index -= 1
        ) {
          aggregateEntriesInspected += 1;
          const nested = readProperty(errors, index);
          if (isObjectLike(nested) && !queued.has(nested)) {
            queued.add(nested);
            pendingAggregates.push(nested);
          }
        }
      }

      if (isObjectLike(cause) && !queued.has(cause)) {
        queued.add(cause);
        pendingCauses.push(cause);
      }
    }

    return null;
  };

  return Object.freeze({ callback, getUpstreamModelError });
}
