import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useLocalize } from '~/hooks';

interface ResultSwitcherProps {
  currentIndex: number;
  totalCount: number;
  onPrevious: () => void;
  onNext: () => void;
}

export default function ResultSwitcher({
  currentIndex,
  totalCount,
  onPrevious,
  onNext,
}: ResultSwitcherProps) {
  const localize = useLocalize();

  if (totalCount <= 1) {
    return null;
  }

  const atFirst = currentIndex === 0;
  const atLast = currentIndex === totalCount - 1;

  return (
    <nav
      aria-label={localize('com_ui_navigate_results')}
      className="border-border-light bg-surface-code flex items-center justify-center gap-1.5 border-t px-3 py-1.5 text-xs"
    >
      <button
        type="button"
        onClick={onPrevious}
        disabled={atFirst}
        aria-label={localize('com_ui_prev_result')}
        className="text-text-tertiary hover:bg-surface-hover hover:text-text-primary focus:outline-border-heavy rounded p-0.5 transition-colors focus:outline focus:outline-2 disabled:pointer-events-none disabled:opacity-30"
      >
        <ChevronLeft className="size-3.5" aria-hidden="true" />
      </button>
      <span className="text-text-secondary min-w-[3ch] text-center tabular-nums select-none">
        {currentIndex + 1}/{totalCount}
      </span>
      <button
        type="button"
        onClick={onNext}
        disabled={atLast}
        aria-label={localize('com_ui_next_result')}
        className="text-text-tertiary hover:bg-surface-hover hover:text-text-primary focus:outline-border-heavy rounded p-0.5 transition-colors focus:outline focus:outline-2 disabled:pointer-events-none disabled:opacity-30"
      >
        <ChevronRight className="size-3.5" aria-hidden="true" />
      </button>
    </nav>
  );
}
