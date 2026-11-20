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
  showToast: ({ message, severity, showIcon, duration, status }: TShowToast) => void;
} {
  const [toast, setToast] = useAtom(toastState);
  const showTimerRef = useRef<number | null>(null);
  /** Whether the show waiting on `showTimerRef` is a persistent error. */
  const pendingPersistentErrorRef = useRef(false);

  useEffect(() => {
    return () => {
      if (showTimerRef.current !== null) {
        clearTimeout(showTimerRef.current);
      }
    };
  }, []);

  const showToast = ({
    message,
    severity = NotificationSeverity.SUCCESS,
    showIcon = true,
    duration = 3000, // default duration for the toast to be visible
    status,
  }: TShowToast): void => {
    const closeAfter = Number.isFinite(duration) && duration > 0 ? duration : Infinity;
    const nextSeverity = (status as NotificationSeverity) ?? severity;

    /** Cancelling the pending show below would drop a persistent error that no one has seen
     *  yet, so it holds against a non-error toast the same way an open one does. */
    if (pendingPersistentErrorRef.current && nextSeverity !== NotificationSeverity.ERROR) {
      return;
    }

    // Clear a pending show that has not fired yet
    if (showTimerRef.current !== null) {
      clearTimeout(showTimerRef.current);
    }

    pendingPersistentErrorRef.current = isPersistentError(closeAfter, nextSeverity);

    // Timeout to show the toast
    showTimerRef.current = window.setTimeout(() => {
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
        return {
          open: true,
          message,
          severity: nextSeverity,
          showIcon,
          duration: closeAfter,
          id: prevToast.id + 1,
        };
      });
    }, showDelay);
  };

  return {
    toast,
    /** Radix keeps a superseded toast's close timer alive past unmount, so it can
     *  otherwise close the toast that replaced it; the id makes that a no-op. */
    onOpenChange: (open: boolean, id: number): void =>
      setToast((prevToast: ToastState) =>
        prevToast.id === id ? { ...prevToast, open } : prevToast,
      ),
    showToast,
  };
}
