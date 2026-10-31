import { createContext } from 'react';
import type { Context } from 'react';

/** The canvas class a message surface paints, which opaque sticky rows repaint to match. */
export type MessageSurface =
  | 'bg-surface-canvas'
  | 'bg-surface-primary-alt'
  | 'bg-surface-secondary'
  | 'bg-surface-dialog';

/** Opaque sticky rows must repaint the canvas their host actually uses. */
export const MessageSurfaceContext: Context<MessageSurface> =
  createContext<MessageSurface>('bg-surface-primary-alt');
