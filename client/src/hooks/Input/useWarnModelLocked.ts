import { useCallback } from 'react';
import { useToastContext } from '@librechat/client';
import { NotificationSeverity } from '~/common';
import { useLocalize } from '~/hooks';

/**
 * Stable callback that shows the standard "model switching is locked for
 * this conversation" toast. Shared by every call site that rejects a
 * model/endpoint/preset switch because `isModelLocked` is true (the `@`
 * mention popover, the Presets menu, ...), so the message, severity and
 * icon stay in sync without duplicating the `showToast` call.
 */
export default function useWarnModelLocked(): () => void {
  const localize = useLocalize();
  const { showToast } = useToastContext();

  return useCallback(() => {
    showToast({
      message: localize('com_ui_model_locked'),
      severity: NotificationSeverity.INFO,
      showIcon: true,
    });
  }, [localize, showToast]);
}
