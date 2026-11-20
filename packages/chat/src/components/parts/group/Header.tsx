import { ChevronDown } from 'lucide-react';
import { Button, cn } from '@librechat/client';
import type { ReactElement, ReactNode, Ref } from 'react';
import type { RailHover } from '../rail';
import { FailedRevealPill } from '../reveal';
import PhaseLabel from '../PhaseLabel';
import { RailGlyph } from '../rail';

export type ToolGroupHeaderProps = {
  label: string;
  detail: string;
  ariaLabel: string;
  expanded: boolean;
  hidden: boolean;
  animate: boolean;
  glyph: ReactNode;
  hover: RailHover;
  headerRef: Ref<HTMLDivElement>;
  actionSlotRef: Ref<HTMLSpanElement>;
  onToggle: () => void;
  failure?: { count: number; total: number; onReveal: () => void };
};

/** The group owns disclosure state; its host supplies the glyph and header action target. */
export default function ToolGroupHeader({
  label,
  detail,
  ariaLabel,
  expanded,
  hidden,
  animate,
  glyph,
  hover,
  headerRef,
  actionSlotRef,
  onToggle,
  failure,
}: ToolGroupHeaderProps): ReactElement {
  return (
    <div
      className={cn('relative w-full items-center gap-2 pe-6', hidden ? 'hidden' : 'flex')}
      hidden={hidden}
      ref={headerRef}
    >
      <Button
        type="button"
        variant="fold-header"
        className="min-w-0 flex-1"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-label={ariaLabel}
        data-fold-toggle=""
      >
        <RailGlyph hover={hover}>{glyph}</RailGlyph>
        <span className="tool-status-text min-w-0 truncate font-medium" role="status" title={label}>
          <PhaseLabel text={label} animate={animate} />
        </span>
        {detail && (
          <span
            className="text-text-secondary max-w-2/5 min-w-0 truncate text-xs font-normal"
            title={detail}
          >
            · {detail}
          </span>
        )}
        <ChevronDown
          className={cn(
            'text-text-secondary absolute end-0 size-4 shrink-0 transition-transform duration-200 ease-out',
            expanded && 'rotate-180',
          )}
          aria-hidden="true"
        />
      </Button>
      {failure && <FailedRevealPill {...failure} />}
      <span ref={actionSlotRef} className="flex shrink-0 items-center empty:hidden" />
    </div>
  );
}
