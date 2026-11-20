import { createContext, useContext, useState } from 'react';
import { createPortal } from 'react-dom';
import { PortalContext as AriakitPortalContext } from '@ariakit/react';
import type { Context, ReactNode } from 'react';
import type { JSX } from 'react/jsx-runtime';

const PortalContext: Context<HTMLElement | null> = createContext<HTMLElement | null>(null);

/**
 * The element this library's menus, dialogs, popovers and tooltips render into, where an app has
 * named one with `PortalProvider`. `undefined` leaves each surface on `document.body`.
 */
export function usePortalContainer(): HTMLElement | undefined {
  return useContext(PortalContext) ?? undefined;
}

export interface PortalProviderProps {
  /** Where the surfaces render. Left out, the provider keeps an element of its own on the page. */
  container?: HTMLElement | null;
  /** Classes for the provider's own element: what the app's stylesheet scopes its rules to. */
  className?: string;
  children: ReactNode;
}

/**
 * Renders every surface beneath it that leaves the document flow into one element rather than
 * into `document.body`, so an app that styles the chat inside a class, or themes part of a page,
 * gives that element the same class and the surfaces keep their styles.
 *
 * The element sits at the end of `document.body`, as the surfaces did, so nothing an ancestor
 * clips or transforms changes where they land.
 */
export function PortalProvider({
  container,
  className,
  children,
}: PortalProviderProps): JSX.Element {
  const [own, setOwn] = useState<HTMLElement | null>(null);
  const owned = container === undefined;
  const target = owned ? own : container;
  return (
    <PortalContext.Provider value={target}>
      <AriakitPortalContext.Provider value={target}>{children}</AriakitPortalContext.Provider>
      {owned &&
        typeof document !== 'undefined' &&
        createPortal(<div ref={setOwn} className={className} />, document.body)}
    </PortalContext.Provider>
  );
}
