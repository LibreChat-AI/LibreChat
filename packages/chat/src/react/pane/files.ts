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

/**
 * The conversation whose composer staged a pane's files. A pane that shows one conversation
 * after another keeps its file map between them, so whoever puts a conversation in the pane
 * compares it with this and empties the map for a new one.
 */
export const filesOwnerFamily: Family<
  string | null,
  PrimitiveAtom<string | null>,
  string | number
> = atomFamily((_index: string | number) => atom<string | null>(null));
