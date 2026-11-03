/** One provider segment's checkpoint commands; this object is never shared between runs. */
export interface CheckpointWriteWitness {
  track<T>(operation: () => Promise<T>): Promise<T>;
  close(): Promise<'settled' | 'unknown'>;
}

/** The caller binds both mutations to the exact durable root and provider segment.
 * Opening must retain uncertainty before a storage command is permitted to start. */
export function createCheckpointWriteWitness(storage: {
  open: () => Promise<void>;
  settle: () => Promise<void>;
}): CheckpointWriteWitness {
  const pending = new Set<Promise<void>>();
  let opening: Promise<void> | undefined;
  let closing: Promise<'settled' | 'unknown'> | undefined;
  let closed = false;
  let unknown = false;
  return {
    track<T>(operation: () => Promise<T>): Promise<T> {
      if (closed) return Promise.reject(new Error('Checkpoint writer is closed'));
      const result = (async () => {
        opening ??= Promise.resolve().then(storage.open);
        await opening;
        try {
          return await operation();
        } catch (error) {
          // A rejected driver promise does not prove the server cannot still apply its command.
          unknown = true;
          throw error;
        }
      })();
      const settled = result.then(
        () => {},
        () => {},
      );
      pending.add(settled);
      void settled.then(() => pending.delete(settled));
      return result;
    },
    close() {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        // All entries handle rejection: the first failure cannot bypass a delayed sibling.
        await Promise.all(pending);
        if (unknown) return 'unknown';
        // Even a rejected opening command may still arrive at the server. The exact
        // writer's settled marker fences it; no checkpoint command was authorized.
        if (opening) await storage.settle();
        return 'settled';
      })();
      return closing;
    },
  };
}
