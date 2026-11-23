import { useEffect } from 'react';
import { useAtomValue } from 'jotai';
import { applyUiScale } from '@librechat/client';
import { uiScaleValueAtom } from '~/store/uiScale';

/**
 * Keeps the scale atom mounted so Jotai's storage subscription stays active and a
 * change made in another tab reaches this one. Renders nothing, which confines the
 * re-render to this leaf instead of the provider tree, where the query client is
 * constructed during render.
 */
export default function UiScaleSync(): null {
  const uiScale = useAtomValue(uiScaleValueAtom);

  /** Reconciles the DOM with the stored value on mount, so a corrupted or
   *  out-of-range entry cannot leave the root scale disagreeing with the setting. */
  useEffect(() => {
    applyUiScale(uiScale);
  }, [uiScale]);

  return null;
}
