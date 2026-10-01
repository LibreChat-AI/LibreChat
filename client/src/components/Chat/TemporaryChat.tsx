import { HatGlasses } from 'lucide-react';
import { Chip, TooltipAnchor } from '@librechat/client';
import { useShortcutAriaKey, useShortcutHint } from '~/hooks/useKeyboardShortcuts';
import useTemporaryChat from '~/hooks/Chat/useTemporaryChat';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

export function TemporaryChat() {
  const localize = useLocalize();
  const { show, isTemporary, isEnforced, toggle } = useTemporaryChat();
  const tooltipDescription = useShortcutHint('toggleTemporaryChat', localize('com_ui_temporary'));
  const ariaKey = useShortcutAriaKey('toggleTemporaryChat');

  if (!show) {
    return null;
  }

  const label = isEnforced ? localize('com_ui_temporary_enforced') : localize('com_ui_temporary');

  return (
    <div className="relative flex flex-wrap items-center gap-2">
      <TooltipAnchor
        description={isEnforced ? label : tooltipDescription}
        render={
          <button
            onClick={toggle}
            aria-label={label}
            aria-pressed={isTemporary}
            aria-disabled={isEnforced}
            aria-keyshortcuts={isEnforced ? undefined : ariaKey}
            className={cn(
              'border-border-light text-text-primary inline-flex size-9 shrink-0 items-center justify-center rounded-xl border transition-all ease-in-out',
              isTemporary
                ? 'bg-surface-active'
                : 'bg-presentation hover:bg-surface-active-alt shadow-xs',
              isEnforced && 'cursor-not-allowed',
            )}
          >
            <HatGlasses className="icon-md" aria-hidden="true" />
          </button>
        }
      />
    </div>
  );
}

/** Once the first message is sent the toggle retires, so the active mode still
 * needs a persistent, read-only cue in the header. `role="status"` carries the
 * mode change to assistive technology, which matters most below `md` where the
 * label is visually hidden and only the icon remains. */
export function TemporaryChatIndicator() {
  const localize = useLocalize();
  const { isActive } = useTemporaryChat();

  if (!isActive) {
    return null;
  }

  return (
    <Chip
      role="status"
      tone="neutral"
      size="theme"
      shape="theme"
      className="shrink-0"
      leading={<HatGlasses className="size-4 shrink-0" aria-hidden="true" />}
    >
      <span className="max-md:sr-only">{localize('com_ui_temporary')}</span>
    </Chip>
  );
}
