import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

type QueuedTurnTarget = {
  conversationId: string;
  clientRequestId: string;
  element: HTMLSpanElement;
};

type QueuedTurnPortalContextValue = {
  target: QueuedTurnTarget | null;
  setTarget: (target: QueuedTurnTarget | null) => void;
};

const QueuedTurnPortalContext = createContext<QueuedTurnPortalContextValue | null>(null);

/** The composer owns queue actions; the transcript only supplies their mount point. */
export function QueuedTurnPortalProvider({ children }: { children: ReactNode }) {
  const [target, setTargetState] = useState<QueuedTurnTarget | null>(null);
  const setTarget = useCallback((next: QueuedTurnTarget | null) => {
    setTargetState((current) =>
      current?.element === next?.element &&
      current?.conversationId === next?.conversationId &&
      current?.clientRequestId === next?.clientRequestId
        ? current
        : next,
    );
  }, []);
  const value = useMemo(() => ({ target, setTarget }), [target, setTarget]);
  return (
    <QueuedTurnPortalContext.Provider value={value}>{children}</QueuedTurnPortalContext.Provider>
  );
}

export const useQueuedTurnPortal = () => useContext(QueuedTurnPortalContext);
