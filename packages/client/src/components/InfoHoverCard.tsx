import { useState } from 'react';
import { JSX } from 'react/jsx-runtime';
import { CircleHelpIcon, InfoIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { HoverCard, HoverCardTrigger, HoverCardPortal, HoverCardContent } from './HoverCard';
import { ESide } from '~/common';

type InfoHoverCardProps = {
  side?: ESide;
  text: string;
  icon?: 'help' | 'info';
  /** Custom trigger content replacing the stock icon (e.g. a status glyph);
   *  the hover text stays the trigger's accessible name either way. */
  children?: ReactNode;
};

const InfoHoverCard = ({
  side,
  text,
  icon = 'help',
  children,
}: InfoHoverCardProps): JSX.Element => {
  const [isOpen, setIsOpen] = useState(false);
  const Icon = icon === 'info' ? InfoIcon : CircleHelpIcon;

  return (
    <HoverCard openDelay={50} open={isOpen} onOpenChange={setIsOpen}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          className="focus-visible:ring-focus-control inline-flex cursor-help items-center justify-center rounded-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-hidden"
          onFocus={() => setIsOpen(true)}
          onBlur={() => setIsOpen(false)}
          aria-label={text}
        >
          {children ?? <Icon className="text-text-tertiary h-5 w-5" aria-hidden="true" />}
        </button>
      </HoverCardTrigger>
      <HoverCardPortal>
        <HoverCardContent side={side} className="z-[999] w-80">
          <div className="max-h-[80vh] space-y-2 overflow-y-auto">
            <span className="text-text-secondary text-sm">{text}</span>
          </div>
        </HoverCardContent>
      </HoverCardPortal>
    </HoverCard>
  );
};

export default InfoHoverCard;
