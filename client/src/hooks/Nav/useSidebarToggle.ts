import { startTransition, useCallback, useMemo } from 'react';
import { useRecoilCallback, useSetRecoilState } from 'recoil';
import type { DrawerKickMode } from './useDrawerSwipe';
import { getPendingDrawerFlip, kickDrawerAnimation } from './useDrawerSwipe';
import store from '~/store';

export type SidebarToggle = {
  /**
   * Opens/closes the sidebar with the slide-first contract. `afterSlide`
   * carries follow-up work — conversation navigation, focus handoffs — that
   * would otherwise run in the tap's task and flush its commit before the
   * slide's first frame. On 'slide' it runs on the same three-frame cadence
   * as the state flip; otherwise immediately.
   */
  setSidebarOpen: (next: boolean, afterSlide?: () => void) => DrawerKickMode;
  /**
   * Inverts the LATEST intent: a second press inside the deferral window
   * reads the pending flip target, not the still-uncommitted atom value, so
   * rapid presses alternate instead of piling onto the same direction.
   */
  toggleSidebar: () => void;
};

/**
 * The one path every sidebar open/close mutation takes. On mobile the drawer
 * slide starts imperatively (see kickDrawerAnimation) and the Recoil flip is
 * deferred past the first frames, so the commit — hundreds of ms on a large
 * conversation — cannot delay first motion. Setting the atom directly
 * reintroduces exactly that stall, which is why conversation selection and
 * the keyboard shortcuts route through here too, not just the toggle
 * buttons. On desktop the flip applies immediately and the width transition
 * animates as before.
 */
export default function useSidebarToggle(): SidebarToggle {
  const setSidebarExpanded = useSetRecoilState(store.sidebarExpanded);

  const setSidebarOpen = useCallback(
    (next: boolean, afterSlide?: () => void) => {
      const mode = kickDrawerAnimation(next, () => {
        startTransition(() => {
          setSidebarExpanded(next);
        });
      });
      if (afterSlide != null) {
        if (mode === 'slide') {
          /** Same cadence as the deferred flip, but deliberately NOT gated
           * on the animator surviving: the user action carried here (a
           * navigation, a focus request) must not vanish because the
           * breakpoint crossed mid-slide. */
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              requestAnimationFrame(afterSlide);
            });
          });
        } else {
          afterSlide();
        }
      }
      return mode;
    },
    [setSidebarExpanded],
  );

  const toggleSidebar = useRecoilCallback(
    ({ snapshot }) =>
      () => {
        const committed = snapshot.getLoadable(store.sidebarExpanded).valueMaybe() as
          | boolean
          | undefined;
        setSidebarOpen(!(getPendingDrawerFlip() ?? committed ?? false));
      },
    [setSidebarOpen],
  );

  return useMemo(() => ({ setSidebarOpen, toggleSidebar }), [setSidebarOpen, toggleSidebar]);
}
