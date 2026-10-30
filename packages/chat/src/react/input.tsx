import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import type { ComposerBindings } from '../core/shortcuts';
import { NO_HOST_BINDINGS } from '../core/shortcuts';

/** Composer actions whose chord the user can rebind and the composer advertises. */
export type ComposerShortcutAction = 'escalateSteer';

/** App capabilities the composer controls read. */
export interface ComposerHost {
  /** The user's effective composer-relevant shortcut bindings. */
  useComposerBindings: () => ComposerBindings;
  /** The chord bound to an action, formatted for display; empty when unbound or shortcuts are off. */
  useShortcutDisplay: (action: ComposerShortcutAction) => string;
  /** The chord bound to an action, in `aria-keyshortcuts` form; undefined when unbound. */
  useShortcutAriaKey: (action: ComposerShortcutAction) => string | undefined;
}

/** Without a host the composer keeps the stock chords and advertises no rebound ones. */
const fallbackHost: ComposerHost = {
  useComposerBindings: () => NO_HOST_BINDINGS,
  useShortcutDisplay: () => '',
  useShortcutAriaKey: () => undefined,
};

const ComposerHostContext = createContext<ComposerHost>(fallbackHost);

/** Supplies the host the composer controls read from. */
export function ComposerHostProvider({
  host,
  children,
}: {
  host: ComposerHost;
  children: ReactNode;
}): ReactNode {
  return <ComposerHostContext.Provider value={host}>{children}</ComposerHostContext.Provider>;
}

/** The host of the nearest provider, or one with the stock chords. */
export function useComposerHost(): ComposerHost {
  return useContext(ComposerHostContext);
}
