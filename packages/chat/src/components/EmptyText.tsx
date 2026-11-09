import { memo } from 'react';
import { cn, TooltipAnchor, useLocalize } from '@librechat/client';
import type { NamedExoticComponent } from 'react';

type EmptyTextPartProps = {
  /**
   * Centers the 12px dot (style.css `.result-thinking`) on the axis of the
   * size-6 message-header icon above it: (24 − 12) / 2, as inline-start
   * padding so the axis holds when the document flips to RTL. Only for
   * placeholders rendering directly beneath the header — leading rows and
   * nested contexts (activity groups, parallel columns, mid-stream parts)
   * keep the flush default.
   */
  underHeaderIcon?: boolean;
};

/**
 * Streaming cursor placeholder, with no bottom margin to match Container's structure and prevent
 * CLS. The tooltip anchors on the wrapper because `.result-thinking` only draws while it is
 * `:empty:last-child`, which a sibling tooltip node would break.
 */
const EmptyTextPart: NamedExoticComponent<EmptyTextPartProps> = memo(
  ({ underHeaderIcon = false }: EmptyTextPartProps) => {
    const localize = useLocalize();
    const label = localize('com_ui_thinking');
    return (
      <div
        data-message-text
        className="flex min-h-[1.25rem] flex-col items-start gap-3 overflow-visible"
      >
        <div className="markdown prose light w-full break-words">
          <TooltipAnchor
            description={label}
            role="img"
            aria-label={label}
            /* The dot unmounts when the first token lands, which would drop keyboard focus. */
            focusable={false}
            render={<div className={cn('absolute', underHeaderIcon && 'ps-1.5')} />}
          >
            <p className="submitting relative">
              <span className="result-thinking" />
            </p>
          </TooltipAnchor>
        </div>
      </div>
    );
  },
);

export default EmptyTextPart;
