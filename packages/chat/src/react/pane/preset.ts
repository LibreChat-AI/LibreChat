import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';
import type { TPreset } from 'librechat-data-provider';
import type { PrimitiveAtom } from 'jotai';
import type { Family } from '../steer/family';

/** The preset applied to one chat pane, keyed by pane index. */
export const presetFamily: Family<
  TPreset | null,
  PrimitiveAtom<TPreset | null>,
  string | number
> = atomFamily((_index: string | number) => atom<TPreset | null>(null));
