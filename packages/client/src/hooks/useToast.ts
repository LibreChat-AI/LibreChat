import { useRef, useEffect } from 'react';
import { useAtom } from 'jotai';
import type { TShowToast } from '~/common';
import { toastState, type ToastState } from '~/store';
import { NotificationSeverity } from '~/common';

/** A persistent error stays until the user dismisses it, so only another error may replace it. */
const isPersistentError = (duration: number, severity: NotificationSeverity): boolean =>
  duration === Infinity && severity === NotificationSeverity.ERROR;

export default function useToast(showDelay = 100): {
  toast: ToastState;
  onOpenChange: (open: boolean, id: number) => void;
  showToast: (options: TShowToast) => (() => void) | undefined;
} {
  const [toast, setToast] = useAtom(toastState);
  const pendingToastRef = useRef<(() => void) | null>(null);
  const pendingPersistentErrorRef = useRef(false);

  useEffect(() => () => pendingToastRef.current?.(), []);

  /** Radix can fire a superseded toast's close timer after it unmounts. */
  const onOpenChange = (open: boolean, id: number): void =>
    setToast((prevToast) =>
      prevToast.id === id && prevToast.open !== open ? { ...prevToast, open } : prevToast,
    );

  const showToast = ({
    message,
    severity = NotificationSeverity.SUCCESS,
    showIcon = true,
    duration = 3000, // default duration for the toast to be visible
    status,
  }: TShowToast): (() => void) | undefined => {
    const closeAfter = Number.isFinite(duration) && duration > 0 ? duration : Infinity;
    const nextSeverity = (status as NotificationSeverity) ?? severity;

    /** Cancelling the pending show below would drop a persistent error that no one has seen
     *  yet, so it holds against a non-error toast the same way an open one does. */
    if (pendingPersistentErrorRef.current && nextSeverity !== NotificationSeverity.ERROR) {
      return;
    }

    pendingToastRef.current?.();
    pendingPersistentErrorRef.current = isPersistentError(closeAfter, nextSeverity);

    let shownId: number | undefined;
    const timer = window.setTimeout(() => {
      pendingToastRef.current = null;
      pendingPersistentErrorRef.current = false;
      /** A new `id` gives the toast its own Radix lifecycle, so its close deadline
       *  starts now even when it replaces a toast that is still open. */
      setToast((prevToast: ToastState) => {
        if (
          nextSeverity !== NotificationSeverity.ERROR &&
          prevToast.open &&
          isPersistentError(prevToast.duration, prevToast.severity)
        ) {
          return prevToast;
        }
        shownId = prevToast.id + 1;
        return {
          open: true,
          message,
          severity: nextSeverity,
          showIcon,
          duration: closeAfter,
          id: shownId,
        };
      });
    }, showDelay);

    const dismiss = () => {
      if (pendingToastRef.current === dismiss) {
        window.clearTimeout(timer);
        pendingToastRef.current = null;
        pendingPersistentErrorRef.current = false;
      } else if (shownId != null) {
        onOpenChange(false, shownId);
      }
    };
    pendingToastRef.current = dismiss;
    return dismiss;
  };

  return { toast, onOpenChange, showToast };
}
