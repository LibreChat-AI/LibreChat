import useScaledMaxWidth from '~/hooks/useScaledMaxWidth';
import { DRAWER_MAX_WIDTH } from '~/utils/breakpoints';

/**
 * Whether navigation is in drawer mode. Shared by the hook that owns the open state and
 * by every route control that reveals the reopen affordance, so they cannot disagree
 * about the current mode.
 */
export default function useDrawerViewport(): boolean {
  return useScaledMaxWidth(DRAWER_MAX_WIDTH);
}
