import { useCallback } from 'react';
import useDrawerViewport from './useDrawerViewport';
import useSidebarToggle from './useSidebarToggle';

/**
 * Runs `start` once the chat it opens can be seen. In drawer mode the drawer closes first through
 * the slide-first toggle and `start` rides the slide, as picking a conversation does; on the wide
 * layout nothing covers the chat, so it runs at once.
 */
export default function useRevealChat(): (start: () => void) => void {
  const isDrawer = useDrawerViewport();
  const { setSidebarOpen } = useSidebarToggle();
  return useCallback(
    (start: () => void) => {
      if (isDrawer) {
        setSidebarOpen(false, start);
        return;
      }
      start();
    },
    [isDrawer, setSidebarOpen],
  );
}
