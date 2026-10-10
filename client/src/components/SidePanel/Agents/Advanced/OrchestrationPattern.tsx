import { HoverCard, HoverCardPortal, HoverCardContent } from '@librechat/client';
import type { ReactNode } from 'react';
import { BetaPill, InfoTrigger } from './ui';
import { ESide } from '~/common';

interface OrchestrationPatternProps {
  icon: ReactNode;
  title: string;
  subtitle: string;
  info: ReactNode;
  beta?: boolean;
  /** Right-aligned status slot: a switch, count pill, etc. */
  trailing?: ReactNode;
  children?: ReactNode;
}

/**
 * One collaboration pattern inside the orchestration hub, rendered as a flat
 * section (no surrounding card): a leading topology icon, a title with optional
 * Beta tag and info popover, a one-line purpose, a trailing status slot, and the
 * pattern's inline configuration body. Sections are separated by dividers, not
 * nested cards.
 */
export default function OrchestrationPattern({
  icon,
  title,
  subtitle,
  info,
  beta,
  trailing,
  children,
}: OrchestrationPatternProps) {
  return (
    <HoverCard openDelay={50}>
      <section aria-label={title} className="flex flex-col gap-3 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2.5">
            <span className="text-text-secondary mt-0.5 shrink-0" aria-hidden="true">
              {icon}
            </span>
            <div className="flex min-w-0 flex-col gap-0.5">
              <div className="flex items-center gap-1.5">
                <span className="text-text-primary text-sm font-medium">{title}</span>
                {beta && <BetaPill />}
                <InfoTrigger />
              </div>
              <p className="text-text-secondary text-xs">{subtitle}</p>
            </div>
          </div>
          {trailing != null && <div className="flex shrink-0 items-center gap-2">{trailing}</div>}
        </div>
        {children != null && <div className="flex flex-col gap-3">{children}</div>}
      </section>
      <HoverCardPortal>
        <HoverCardContent side={ESide.Top} className="w-80">
          <div className="space-y-2">{info}</div>
        </HoverCardContent>
      </HoverCardPortal>
    </HoverCard>
  );
}
