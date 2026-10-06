import { createContext } from 'react';

/** Opaque sticky rows must repaint the canvas their host actually uses. */
export const MessageSurfaceContext = createContext<
  'bg-surface-canvas' | 'bg-surface-primary-alt' | 'bg-surface-secondary' | 'bg-surface-dialog'
>('bg-surface-primary-alt');
