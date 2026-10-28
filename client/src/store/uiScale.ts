import { atom } from 'jotai';
import { atomWithStorage, createJSONStorage } from 'jotai/utils';
import { applyUiScale, clampUiScale, DEFAULT_UI_SCALE } from '@librechat/client';

/**
 * Applies the scale to the DOM on every path that changes the stored value,
 * including a storage event from another tab, and before Jotai notifies
 * subscribers so a render never observes a value the DOM has not caught up to.
 *
 * Browser zoom (Ctrl -/+) is left untouched on purpose: it is an accessibility
 * affordance people rely on, and the two zoom levels would compound.
 */
const createUiScaleStorage = () => {
  const storage = createJSONStorage<number>(() => localStorage);

  return {
    ...storage,
    setItem: (key: string, value: number) => {
      storage.setItem(key, value);
      applyUiScale(value);
    },
    subscribe: (key: string, callback: (value: number) => void, initialValue: number) =>
      storage.subscribe?.(
        key,
        (value: number) => {
          applyUiScale(value);
          callback(value);
        },
        initialValue,
      ) ?? (() => undefined),
  };
};

/** This atom stores the user's interface scale preference. */
export const uiScaleAtom = atomWithStorage<number>(
  'uiScale',
  DEFAULT_UI_SCALE,
  createUiScaleStorage(),
  { getOnInit: true },
);

/** Read-only, always-valid scale for consumers that cannot tolerate a bad value. */
export const uiScaleValueAtom = atom((get) => clampUiScale(get(uiScaleAtom)));
