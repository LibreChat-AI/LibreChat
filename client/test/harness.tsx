import { useState } from 'react';
import { createStore, Provider as JotaiProvider } from 'jotai';
import type { ChatSurface } from '~/components/Chat/Subagents/surface';
import type { ReactNode } from 'react';
import { ChatSurfaceProvider } from '~/components/Chat/Subagents/surface';

export type JotaiStore = ReturnType<typeof createStore>;

/** The application's own defaults, so a test that does not care about a
 *  preference reads what a reader who never changed one would see. */
export const testChatSurface = (overrides: Partial<ChatSurface> = {}): ChatSurface => ({
  enterToSend: true,
  maximizeChatSpace: false,
  showScrollButton: true,
  composerBindings: {
    shortcutsEnabled: true,
    submitOverride: undefined,
    yieldedChords: new Set<string>(),
  },
  claimForeground: () => undefined,
  handOffComposerText: () => undefined,
  ...overrides,
});

/**
 * One test's own atom store. Jotai's default store is module-global, so
 * without a provider one test's selection is still there for the next.
 */
export function IsolatedAtomStore({
  seed,
  children,
}: {
  seed?: (store: JotaiStore) => void;
  children: ReactNode;
}) {
  const [store] = useState(() => {
    const created = createStore();
    seed?.(created);
    return created;
  });
  return <JotaiProvider store={store}>{children}</JotaiProvider>;
}

/** An isolated store plus the host half of the seam the feature reads through. */
export function ChatSurfaceHarness({
  surface,
  seed,
  children,
}: {
  surface?: ChatSurface;
  seed?: (store: JotaiStore) => void;
  children: ReactNode;
}) {
  return (
    <IsolatedAtomStore seed={seed}>
      <ChatSurfaceProvider value={surface ?? testChatSurface()}>{children}</ChatSurfaceProvider>
    </IsolatedAtomStore>
  );
}
