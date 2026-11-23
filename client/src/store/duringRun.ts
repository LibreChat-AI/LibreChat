import { atom } from 'jotai';
import type { DuringRunAction } from '~/hooks/Chat/contract';
import { createStorageAtom, initializeFromStorage } from './jotai-utils';

export function migrateDuringRunAction(action: string, interrupts: boolean): DuringRunAction {
  if (action === 'queue') return 'queue';
  if (action === 'interrupt' || (action === 'steer' && interrupts)) return 'interrupt';
  return 'steer';
}

/** Keep legacy keys untouched so older clients retain their saved behavior. */
const storedAction = createStorageAtom<DuringRunAction>(
  'duringRunAction',
  migrateDuringRunAction(
    initializeFromStorage('duringRunDefaultAction', 'steer'),
    initializeFromStorage('steerInterruptsByDefault', false),
  ),
);

export const duringRunActionAtom = atom(
  (get) => migrateDuringRunAction(get(storedAction), false),
  (_get, set, action: DuringRunAction) => set(storedAction, action),
);
