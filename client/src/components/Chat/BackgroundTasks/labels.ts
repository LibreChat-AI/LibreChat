import type { TaskRowDelivery, TaskRowStatus } from './rows';
import type { TranslationKeys } from '~/hooks/useLocalize';

export const STATUS_KEYS: Record<TaskRowStatus, TranslationKeys> = {
  running: 'com_ui_background_tasks_running',
  stopping: 'com_ui_background_tasks_stopping',
  completed: 'com_ui_background_tasks_completed',
  error: 'com_ui_failed',
  cancelled: 'com_ui_cancelled',
};

export const STATUS_CLASSES: Partial<Record<TaskRowStatus, string>> = {
  error: 'text-status-error',
  cancelled: 'text-status-warning',
};

export const DELIVERY_KEYS: Record<TaskRowDelivery, TranslationKeys> = {
  pending: 'com_ui_background_tasks_result_pending',
  failed: 'com_ui_background_tasks_result_undelivered',
};

export const DELIVERY_CLASSES: Partial<Record<TaskRowDelivery, string>> = {
  failed: 'text-status-warning',
};
