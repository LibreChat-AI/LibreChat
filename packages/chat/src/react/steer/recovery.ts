import { atomFamily, atomWithStorage, createJSONStorage } from 'jotai/utils';
import type { WritableAtom } from 'jotai';
import type { RESET } from 'jotai/utils';
import type { RecoveryDispositions } from '../../core/steer/recovery';
import type { Family } from './family';

type SetStateActionWithReset<Value> =
  | Value
  | typeof RESET
  | ((prev: Value) => Value | typeof RESET);

/** Receipt-scoped safety decisions survive remounts and reloads in this tab.
 * No message content is stored. A crashed cancellation stays held, not sendable. */
export const recoveryDispositionsFamily: Family<
  RecoveryDispositions,
  WritableAtom<RecoveryDispositions, [SetStateActionWithReset<RecoveryDispositions>], void>
> = atomFamily((conversationId: string) =>
  atomWithStorage<RecoveryDispositions>(
    `steer-recovery:${conversationId}`,
    {},
    createJSONStorage(
      () => ({
        getItem(key) {
          try {
            return sessionStorage.getItem(key);
          } catch {
            return null;
          }
        },
        setItem(key, value) {
          try {
            sessionStorage.setItem(key, value);
          } catch {
            /* Keep the in-memory safety decision. */
          }
        },
        removeItem(key) {
          try {
            sessionStorage.removeItem(key);
          } catch {
            /* Storage may be disabled. */
          }
        },
      }),
      {
        reviver: (_key, value) => (value === 'cancelling' ? 'blocked' : value),
      },
    ),
    { getOnInit: true },
  ),
);
