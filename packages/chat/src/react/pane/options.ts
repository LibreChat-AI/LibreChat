import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';
import type { PrimitiveAtom } from 'jotai';
import type { Family } from '../steer/family';

/** Legacy per-pane option toggles (examples, code chat). */
export type PaneOptionSettings = {
  showExamples?: boolean;
  isCodeChat?: boolean;
};

/** Option toggles of one chat pane, keyed by pane index. */
export const optionSettingsFamily: Family<
  PaneOptionSettings,
  PrimitiveAtom<PaneOptionSettings>,
  string | number
> = atomFamily((_index: string | number) => atom<PaneOptionSettings>({}));
