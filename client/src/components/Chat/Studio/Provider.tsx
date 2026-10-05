import { useRecoilValue } from 'recoil';
import type { ReactNode } from 'react';
import { useMediaAccess } from '~/hooks/Media/useMediaAccess';
import { useShareContext } from '~/Providers';
import { StudioContext } from './context';
import store from '~/store';

export function StudioProvider({ children }: { children: ReactNode }) {
  const { shareId } = useShareContext();
  const { studio } = useMediaAccess();
  const temporary = useRecoilValue(store.isTemporary);
  const available = studio && !shareId && !temporary;
  return <StudioContext.Provider value={available}>{children}</StudioContext.Provider>;
}
