import { RefreshCcw } from 'lucide-react';
import type { TMessage } from 'librechat-data-provider';
import { useLocalize } from '~/hooks';

/** Whether the server re-anchored the prompt for this reply (`metadata.promptCacheReset`). */
export function hasPromptCacheReset(message?: TMessage | null): boolean {
  const reasons = message?.metadata?.promptCacheReset;
  return Array.isArray(reasons) && reasons.length > 0;
}

/**
 * A reply whose request reloaded earlier context because the user changed something
 * every cached prefix depends on. The server records the reset only for providers that
 * have a prompt cache and only with `promptCache.stableContext`, so this shows nowhere else.
 */
export default function PromptCacheResetNotice({ message }: { message: TMessage }) {
  const localize = useLocalize();
  if (!hasPromptCacheReset(message)) {
    return null;
  }
  return (
    <p className="text-text-secondary my-1 flex items-center gap-2 text-xs">
      <RefreshCcw className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      {localize('com_ui_context_reloaded')}
    </p>
  );
}
