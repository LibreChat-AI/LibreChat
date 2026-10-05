import type { ShortcutActionId } from '~/hooks/useKeyboardShortcuts';
import { useShortcutAriaKey, useShortcutDisplay } from '~/hooks/useKeyboardShortcuts';
import { cn, removeFocusOutlines } from '~/utils/';

export default function Button({
  type = 'regenerate',
  children,
  onClick,
  className = '',
  shortcutId,
}: {
  type?: 'regenerate' | 'continue' | 'stop';
  children: React.ReactNode;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  className?: string;
  shortcutId?: ShortcutActionId;
}) {
  const shortcutDisplay = useShortcutDisplay(shortcutId);
  const ariaKey = useShortcutAriaKey(shortcutId);

  return (
    <button
      data-testid={`${type}-generation-button`}
      aria-keyshortcuts={ariaKey}
      className={cn(
        'custom-btn btn-neutral relative -z-0 border-0 whitespace-nowrap md:border',
        removeFocusOutlines,
        className,
      )}
      onClick={onClick}
    >
      <div className="flex w-full items-center justify-center gap-2">
        {children}
        {shortcutDisplay && (
          <span className="border-border-light text-text-secondary hidden rounded-md border px-1.5 py-0.5 text-[10px] leading-none md:inline-flex">
            {shortcutDisplay}
          </span>
        )}
      </div>
    </button>
  );
}
