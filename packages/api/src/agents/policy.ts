import type { FiltersConfig, MessageFilterConfig } from 'librechat-data-provider';
import type {
  ModelBoundChatModelCallback,
  ModelBoundProviderContentInput,
} from '~/middleware/modelBoundContent';
import type { TerminalRunErrorObserver } from './failures/terminal';
import type { ModelErrorTrackerCallback } from './failures/tracker';
import { createModelBoundChatModelCallback } from '~/middleware/modelBoundContent';

/** Shares native model-input policy and terminal error tracking across API callers. */
export function createApiModelCallbacks({
  appConfig,
  terminalRunError,
  onTraversalFailure,
  storedMessages,
  resolvedFiles,
}: Pick<
  ModelBoundProviderContentInput,
  'onTraversalFailure' | 'storedMessages' | 'resolvedFiles'
> & {
  appConfig?: { filters?: FiltersConfig; messageFilter?: MessageFilterConfig };
  terminalRunError?: Pick<TerminalRunErrorObserver, 'modelCallback'>;
}): Array<ModelBoundChatModelCallback | ModelErrorTrackerCallback> {
  const policy = createModelBoundChatModelCallback({
    onTraversalFailure,
    filters: appConfig?.filters,
    legacyPii: appConfig?.messageFilter?.pii,
    storedMessages,
    resolvedFiles,
  });
  return terminalRunError == null ? [policy] : [policy, terminalRunError.modelCallback];
}
