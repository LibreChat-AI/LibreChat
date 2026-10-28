import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';
import type { PrimitiveAtom } from 'jotai';
import type { ExtendedFile } from '../../core/files';
import type { Family } from '../steer/family';

/** Files staged in one chat pane's composer, keyed by file id, per pane index. */
export const filesFamily: Family<
  Map<string, ExtendedFile>,
  PrimitiveAtom<Map<string, ExtendedFile>>,
  string | number
> = atomFamily((_index: string | number) => atom<Map<string, ExtendedFile>>(new Map()));
