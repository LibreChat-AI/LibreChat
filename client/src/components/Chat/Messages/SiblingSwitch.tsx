import { Button } from '@librechat/client';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { TMessageProps } from '~/common';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

type TSiblingSwitchProps = Pick<TMessageProps, 'siblingIdx' | 'siblingCount' | 'setSiblingIdx'> & {
  className?: string;
};

export default function SiblingSwitch({
  siblingIdx,
  siblingCount,
  setSiblingIdx,
  className,
}: TSiblingSwitchProps) {
  const localize = useLocalize();

  if (siblingIdx === undefined) {
    return null;
  } else if (siblingCount === undefined) {
    return null;
  }

  const previous = () => {
    setSiblingIdx && setSiblingIdx(siblingIdx - 1);
  };

  const next = () => {
    setSiblingIdx && setSiblingIdx(siblingIdx + 1);
  };

  const buttonStyle = cn(
    'hover-button h-auto rounded-lg p-1.5 text-text-secondary-alt',
    'hover:text-text-primary hover:bg-surface-hover',
    'group-hover:visible group-focus-visible:visible group-has-[:focus-visible:not(:is(input,textarea,[contenteditable]))]:visible group-[.final-completion]:visible',
    'focus-visible:ring-2 focus-visible:ring-text-primary',
  );

  return siblingCount > 1 ? (
    <nav
      className={cn(
        'visible flex items-center justify-center gap-2 self-center pt-0 text-xs',
        className,
      )}
      aria-label={localize('com_ui_sibling_navigation')}
    >
      <Button
        variant="ghost"
        className={buttonStyle}
        onClick={previous}
        disabled={siblingIdx == 0}
        aria-label={localize('com_ui_previous_sibling')}
        aria-disabled={siblingIdx == 0}
      >
        <ChevronLeft size="19" aria-hidden="true" />
      </Button>
      <span
        className="shrink-0 grow tabular-nums"
        aria-live="polite"
        aria-atomic="true"
        role="status"
      >
        {siblingIdx + 1} / {siblingCount}
      </span>
      <Button
        variant="ghost"
        className={buttonStyle}
        onClick={next}
        disabled={siblingIdx == siblingCount - 1}
        aria-label={localize('com_ui_next_sibling')}
        aria-disabled={siblingIdx == siblingCount - 1}
      >
        <ChevronRight size="19" aria-hidden="true" />
      </Button>
    </nav>
  ) : null;
}
