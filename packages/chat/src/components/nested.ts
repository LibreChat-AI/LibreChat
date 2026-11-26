import { createContext } from 'react';
import type { Context, ReactNode } from 'react';
import type { ContentPartsProps } from './contentTypes';

/** Draws a message's parts with the renderer, and the host's slots, drawing the message around. */
export type NestedContentRenderer = (props: Omit<ContentPartsProps, 'slots'>) => ReactNode;

/**
 * The content renderer drawing the current message, for a part that draws parts of its own, such
 * as a subagent card's live row. Provided by `ContentParts`; `null` for a part drawn outside one.
 * A context, because the part cards cannot import the renderer that imports them.
 */
export const NestedContentContext: Context<NestedContentRenderer | null> =
  createContext<NestedContentRenderer | null>(null);
