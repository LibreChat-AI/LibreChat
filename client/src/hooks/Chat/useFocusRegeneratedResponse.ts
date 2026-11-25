import { useCallback } from 'react';
import { useStore } from 'jotai';
import { siblingIdxFamily, siblingKey } from '~/components/Chat/Messages/Thread/state';

/**
 * Focus a regenerated response's fork on its newest sibling. A regeneration
 * appends the new response as the newest child of its parent, but when the
 * parent already had multiple siblings the child count is unchanged (the slice
 * keeps unrelated branches), so MultiMessage's length-change reset never fires
 * and the view would otherwise stay on the kept sibling. Selecting reversed
 * index 0 (newest = the appended response) makes the regenerating branch
 * visible — applied at the optimistic render and reaffirmed on the `created`
 * event so there is no flash on the kept sibling in between.
 */
export default function useFocusRegeneratedResponse() {
  const jotaiStore = useStore();
  return useCallback(
    (parentMessageId?: string | null) => {
      if (parentMessageId == null) {
        return;
      }
      jotaiStore.set(siblingIdxFamily(siblingKey(parentMessageId)), 0);
    },
    [jotaiStore],
  );
}
