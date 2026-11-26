import { createContext, useContext } from 'react';
import type useTarget from '~/hooks/Chat/target';

export const TargetContext = createContext<
  Pick<
    ReturnType<typeof useTarget>,
    'ready' | 'pending' | 'failed' | 'denied' | 'missing' | 'retry'
  >
>({
  ready: false,
  pending: true,
  failed: false,
  denied: false,
  missing: false,
  retry: () => {},
});

export const useTargetContext = () => useContext(TargetContext);
