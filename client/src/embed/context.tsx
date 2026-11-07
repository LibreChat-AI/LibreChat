import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';

const EmbedContext = createContext(false);

/** Supplied by the app shell so features read embed mode without reaching for global state. */
export function EmbedProvider({ embedded, children }: { embedded: boolean; children: ReactNode }) {
  return <EmbedContext.Provider value={embedded}>{children}</EmbedContext.Provider>;
}

/** Whether the app is running framed inside a host page, showing only chat and chat history. */
export const useEmbedded = (): boolean => useContext(EmbedContext);
