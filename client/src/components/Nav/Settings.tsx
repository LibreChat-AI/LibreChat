import { lazy, Suspense, useEffect } from 'react';
import { atom, useAtom } from 'jotai';
import type { SettingsTab } from './Settings/types';

export const settingsOpenAtom = atom(false);
/** Where the next Settings open should land; an entry claims it by id and clears it. */
export const settingsTargetAtom = atom<{ tab: SettingsTab; entry?: string } | null>(null);

/** Keep settings lazy without tying its lifetime to a responsive account-menu trigger. */
const SettingsDialog = lazy(() => import('./Settings/Dialog'));

export default function Settings() {
  const [open, setOpen] = useAtom(settingsOpenAtom);

  useEffect(() => () => setOpen(false), [setOpen]);

  return open ? (
    <Suspense fallback={null}>
      <SettingsDialog open={open} onOpenChange={setOpen} />
    </Suspense>
  ) : null;
}
