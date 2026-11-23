import React from 'react';
import { HoverCardPortal, HoverCardContent } from '@librechat/client';
import { TranslationKeys, useLocalize } from '~/hooks';
import useDirection from '~/hooks/Nav/useDirection';
import { ESide } from '~/common';

/** Callers name the side for an LTR layout; RTL mirrors the horizontal ones. */
const mirrorSide = (side: ESide): ESide => {
  if (side === ESide.Left) {
    return ESide.Right;
  }
  return side === ESide.Right ? ESide.Left : side;
};

type TOptionHoverProps = {
  description: string;
  langCode?: boolean;
  sideOffset?: number;
  disabled?: boolean;
  side: ESide;
  className?: string;
};

function OptionHover({
  side,
  description,
  disabled,
  langCode,
  sideOffset = 30,
  className,
}: TOptionHoverProps) {
  const localize = useLocalize();
  const direction = useDirection();
  if (disabled) {
    return null;
  }
  const text = langCode ? localize(description as TranslationKeys) : description;
  return (
    <HoverCardPortal>
      <HoverCardContent
        side={direction === 'rtl' ? mirrorSide(side) : side}
        className={`z-[999] w-80 ${className}`}
        sideOffset={sideOffset}
      >
        <div className="space-y-2">
          <p className="text-text-secondary text-sm whitespace-pre-wrap">{text}</p>
        </div>
      </HoverCardContent>
    </HoverCardPortal>
  );
}

export default OptionHover;
