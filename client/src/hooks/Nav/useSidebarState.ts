import { useEffect, useRef } from 'react';
import { useRecoilState } from 'recoil';
import type { SetterOrUpdater } from 'recoil';
import useDrawerViewport from './useDrawerViewport';
import store from '~/store';

export type SidebarState = {
  isSmallScreen: boolean;
  expanded: boolean;
  setExpanded: SetterOrUpdater<boolean>;
};

/**
 * Shared reader for the sidebar's open state.
 *
 * The persisted value is normalized when the atom initializes, which covers
 * loading straight onto a phone. Crossing the breakpoint afterwards — narrowing
 * a window, rotating a tablet — has no such moment, and an expanded desktop
 * sidebar would become a drawer covering the whole app.
 *
 * Correcting that in an effect would still paint one frame with the drawer open
 * and the conversation translated fully offscreen, then animate both back over
 * 300ms. So the closed state is *derived during the transition render* and the
 * effect only commits it. Both the drawer and the content pane read through
 * here so they can never disagree about that frame.
 */
export default function useSidebarState(): SidebarState {
  const isSmallScreen = useDrawerViewport();
  const [expanded, setExpanded] = useRecoilState(store.sidebarExpanded);
  const wasSmallScreen = useRef(isSmallScreen);

  const enteredMobile = isSmallScreen && !wasSmallScreen.current;

  useEffect(() => {
    wasSmallScreen.current = isSmallScreen;
    if (enteredMobile) {
      setExpanded(false);
    }
  }, [isSmallScreen, enteredMobile, setExpanded]);

  return {
    isSmallScreen,
    expanded: enteredMobile ? false : expanded,
    setExpanded,
  };
}
