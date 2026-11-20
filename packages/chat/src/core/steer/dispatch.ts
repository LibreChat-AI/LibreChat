/** Runs one keyed task at a time; `settle` releases the key for the next task. */
export type SteerDispatch = (key: string, dispatch: (settle: () => void) => void) => void;

/**
 * First-party FIFO admission: validation inside the steer route can await
 * agent ACL and attachment reads, so overlapping POSTs could otherwise reach
 * the durable queue out of submission order. Keep one request in flight per
 * conversation; later optimistic chips retain the epoch/id/time captured at
 * submission and dispatch only after the prior request settles.
 */
export function createSteerDispatch(): SteerDispatch {
  const queues = new Map<
    string,
    {
      active: boolean;
      pending: Array<(settle: () => void) => void>;
    }
  >();
  return (key, dispatch) => {
    const existing = queues.get(key);
    const state = existing ?? { active: false, pending: [] };
    if (existing == null) {
      queues.set(key, state);
    }
    state.pending.push(dispatch);

    const startNext = () => {
      if (state.active) {
        return;
      }
      const next = state.pending[0];
      if (next == null) {
        if (queues.get(key) === state) {
          queues.delete(key);
        }
        return;
      }
      state.active = true;
      let settled = false;
      const settle = () => {
        if (settled) {
          return;
        }
        settled = true;
        const index = state.pending.indexOf(next);
        if (index >= 0) {
          state.pending.splice(index, 1);
        }
        state.active = false;
        startNext();
      };
      try {
        next(settle);
      } catch (error) {
        settle();
        throw error;
      }
    };

    startNext();
  };
}
