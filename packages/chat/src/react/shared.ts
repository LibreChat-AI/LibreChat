import { useRef } from 'react';

/**
 * Keeps returning the value it returned last time for as long as the next one is `same` as it.
 * For what a render derives again from input that changes on every streamed update: when the
 * derived value comes out equal, everything memoized on it below sees no change. `same` must be
 * a full comparison, since the earlier object stands in for the later one.
 */
export function useShared<T>(value: T, same: (previous: T, next: T) => boolean): T {
  const shared = useRef(value);
  if (shared.current !== value && !same(shared.current, value)) {
    shared.current = value;
  }
  return shared.current;
}
