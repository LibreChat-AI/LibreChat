import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';
import type { PrimitiveAtom } from 'jotai';
import type { Family } from './steer/family';

export const showSkillsPopoverFamily: Family<
  boolean,
  PrimitiveAtom<boolean>,
  string | number | null
> = atomFamily((_index: string | number | null) => atom(false));
