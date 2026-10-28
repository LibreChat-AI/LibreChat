import { useRecoilCallback } from 'recoil';
import store from '~/store';

/**
 * Hook that provides lazy access to addedConvo without subscribing to changes.
 * Use this to avoid unnecessary re-renders when addedConvo changes.
 */
export default function useGetAddedConvo() {
  return useRecoilCallback(
    ({ snapshot }) =>
      () =>
        snapshot.getLoadable(store.conversationByKeySelector(1)).getValue(),
    [],
  );
}
