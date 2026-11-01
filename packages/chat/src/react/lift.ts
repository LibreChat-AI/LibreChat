import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';
import type { PrimitiveAtom } from 'jotai';
import type { Family } from './steer/family';

/** Landing-page lift is composer-owned UI state, scoped to its split pane. */
export const composerLiftFamily: Family<number, PrimitiveAtom<number>, number> = atomFamily(
  (_index: number) => atom(0),
);
