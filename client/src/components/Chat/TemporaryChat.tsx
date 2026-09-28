import { HatGlasses } from 'lucide-react';
import { Chip, TooltipAnchor } from '@librechat/client';
import { useShortcutAriaKey, useShortcutHint } from '~/hooks/useKeyboardShortcuts';
import useTemporaryChat from '~/hooks/Chat/useTemporaryChat';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

export function TemporaryChat() {
  const localize = useLocalize();
  const { show, isTemporary, toggle } = useTemporaryChat();
  const tooltipDescription = useShortcutHint('toggleTemporaryChat', localize('com_ui_temporary'));
  const ariaKey = useShortcutAriaKey('toggleTemporaryChat');

  if (!show) {
    return null;
  }

  return (
    <div className="relative flex flex-wrap items-center gap-2">
      <TooltipAnchor
        description={tooltipDescription}
        render={
          <button
            onClick={toggle}
            aria-label={localize('com_ui_temporary')}
            aria-pressed={isTemporary}
            aria-keyshortcuts={ariaKey}
            className={cn(
              'inline-flex size-9 flex-shrink-0 items-center justify-center rounded-xl border border-border-light text-text-primary transition-all ease-in-out',
              isTemporary
                ? 'bg-surface-active'
                : 'bg-presentation shadow-sm hover:bg-surface-active-alt',
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
      className="flex-shrink-0"
      leading={<HatGlasses className="size-4 shrink-0" aria-hidden="true" />}
    >
      <span className="max-md:sr-only">{localize('com_ui_temporary')}</span>
    </Chip>
  );
}
