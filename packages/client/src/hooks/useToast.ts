import { useRef, useEffect } from 'react';
import { useAtom } from 'jotai';
import type { TShowToast } from '~/common';
import { toastState, type ToastState } from '~/store';
import { NotificationSeverity } from '~/common';

export default function useToast(showDelay = 100): {
  toast: ToastState;
  onOpenChange: (open: boolean, id: number) => void;
  showToast: ({ message, severity, showIcon, duration, status }: TShowToast) => void;
} {
  const [toast, setToast] = useAtom(toastState);
  const showTimerRef = useRef<number | null>(null);

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
    // Clear a pending show that has not fired yet
    if (showTimerRef.current !== null) {
      clearTimeout(showTimerRef.current);
    }

    const closeAfter = Number.isFinite(duration) && duration > 0 ? duration : Infinity;

    // Timeout to show the toast
    showTimerRef.current = window.setTimeout(() => {
      /** A new `id` gives the toast its own Radix lifecycle, so its close deadline
       *  starts now even when it replaces a toast that is still open. */
      setToast((prevToast: ToastState) => ({
        open: true,
        message,
        severity: (status as NotificationSeverity) ?? severity,
        showIcon,
        duration: closeAfter,
        id: prevToast.id + 1,
      }));
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
