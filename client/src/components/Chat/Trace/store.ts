import { atom } from 'jotai';
import type { TraceMode, TraceScale } from './model';
import { createStorageAtom } from '~/store/jotai-utils';

/**
 * The conversation whose trace covers the chat surface, or `null` when the chat
 * shows. Keyed by conversation so a trace never survives into another chat.
 * Memory-only: a reload returns to the conversation.
 */
export const traceViewerConversationAtom = atom<string | null>(null);

/** Which records the ledger shows: the model calls and tools, or every span. */
export const traceModeAtom = createStorageAtom<TraceMode>('traceViewerMode', 'simple');

/** How the overview and bars are scaled: one block per record, or recorded time. */
export const traceScaleAtom = createStorageAtom<TraceScale>('traceViewerScale', 'sequence');
