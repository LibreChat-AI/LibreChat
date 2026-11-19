import { useId } from 'react';
import { BadgeCheck } from 'lucide-react';
import { TooltipAnchor } from '@librechat/client';
import { useAgentOfficialStatus, useLocalize } from '~/hooks';
import { cn } from '~/utils';

interface OfficialAgentIconProps {
  /** Sized in `em`, so by default the badge follows the font size of the name beside it. */
  className?: string;
  /** Drops the tooltip and tab stop, for use inside a button that is already the control. */
  static?: boolean;
}

/**
 * Renders nothing while `interface.agentOfficialStatus` is off, so every surface that shows the
 * badge is gated by the one switch. The accessible name stays the short "Official agent" label; an
 * admin-configured explanation becomes its description, so a screen reader hears both. The
 * description lives in a `hidden` node because `role="img"` does not support `aria-description`.
 */
export default function OfficialAgentIcon({
  className,
  static: isStatic = false,
}: OfficialAgentIconProps) {
  const localize = useLocalize();
  const descriptionId = useId();
  const { enabled, description } = useAgentOfficialStatus();

  if (!enabled) {
    return null;
  }

  const label = localize('com_ui_official_agent');
  const hasExplanation = description !== label;
  const badgeClass = cn(
    'text-status-info inline-flex size-[0.8em] shrink-0 items-center',
    !isStatic && 'cursor-help',
    className,
  );
  const badge = <BadgeCheck aria-hidden="true" className="size-full" />;

  if (isStatic) {
    return (
      <span role="img" aria-label={label} title={description} className={badgeClass}>
        {badge}
      </span>
    );
  }

  return (
    <>
      <TooltipAnchor
        description={description}
        render={
          <span
            tabIndex={0}
            role="img"
            aria-label={label}
            aria-describedby={hasExplanation ? descriptionId : undefined}
            className={badgeClass}
          >
            {badge}
          </span>
        }
      />
      {hasExplanation && (
        <span id={descriptionId} hidden>
          {description}
        </span>
      )}
    </>
  );
}
