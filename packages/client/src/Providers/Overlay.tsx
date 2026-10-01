import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef } from 'react';
import type { Provider, ReactNode, ReactElement } from 'react';

export interface OverlayRegistration {
  id: string;
  depth: number;
  onClose: () => void;
}

export type RegisterOverlay = (overlay: OverlayRegistration) => () => void;

const OverlayContext = createContext<RegisterOverlay | null>(null);
const OverlayDepth = createContext(0);

/** The application owns navigation; shared UI only reports dismissible layers. */
export const OverlayBackProvider: Provider<RegisterOverlay | null> = OverlayContext.Provider;

export function OverlayBack({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}): ReactElement {
  const register = useContext(OverlayContext);
  const depth = useContext(OverlayDepth) + 1;
  const id = useId();
  const closeRef = useRef(onClose);
  useLayoutEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open || register == null) return;
    return register({ id, depth, onClose: () => closeRef.current() });
  }, [depth, id, open, register]);

  return <OverlayDepth.Provider value={depth}>{children}</OverlayDepth.Provider>;
}
