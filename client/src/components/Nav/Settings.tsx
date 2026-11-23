import { lazy, Suspense, useEffect } from 'react';
import { atom, useAtom } from 'jotai';
import type { SectionId, SettingsTab } from './Settings/types';

interface SettingsTarget {
  tab: SettingsTab;
  section?: SectionId;
  trigger?: HTMLButtonElement | null;
}

export const settingsOpenAtom = atom(false);
const settingsTargetAtom = atom<SettingsTarget | null>(null);
export const openSettingsAtom = atom(null, (_get, set, target: SettingsTarget) => {
  set(settingsTargetAtom, target);
  set(settingsOpenAtom, true);
});

/** Keep settings lazy without tying its lifetime to a responsive account-menu trigger. */
const SettingsDialog = lazy(() => import('./Settings/Dialog'));

export default function Settings() {
  const [open, setOpen] = useAtom(settingsOpenAtom);
  const [target, setTarget] = useAtom(settingsTargetAtom);

  useEffect(
    () => () => {
      setOpen(false);
      setTarget(null);
    },
    [setOpen, setTarget],
  );

  return open ? (
    <Suspense fallback={null}>
      <SettingsDialog
        open={open}
        initialTab={target?.tab}
        initialSection={target?.section}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (!nextOpen) {
            setTarget(null);
            // The lazy dialog may load after its opener's focus event, so its
            // focus history cannot always restore a shortcut on the first open.
            const trigger = target?.trigger;
            if (trigger != null) {
              requestAnimationFrame(() => {
                if (trigger.isConnected) {
                  trigger.focus();
                }
              });
            }
          }
        }}
      />
    </Suspense>
  ) : null;
}
