import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Check, Link } from 'lucide';
import { Button, MorphIcon, useToastContext } from '@librechat/client';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

const RESET_MS = 3000;
const LABEL_CLASSES =
  'col-start-1 row-start-1 overflow-hidden transition-all duration-300 ease-out motion-reduce:transition-none';

interface CopyLinkProps {
  url: string;
  disabled?: boolean;
}

/**
 * The two states share one grid cell and cross-fade, while the cell animates to the
 * measured width of whichever label is showing. Widths come from intrinsic (`w-max`)
 * inner spans, so a font swap or a translated label re-measures instead of clipping.
 */
export default function CopyLink({ url, disabled = false }: CopyLinkProps) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const [isCopied, setIsCopied] = useState(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(resetTimerRef.current), []);

  const idleLabel = localize('com_agents_copy_link');
  const copiedLabel = localize('com_agents_link_copied');
  const idleRef = useRef<HTMLSpanElement>(null);
  const copiedRef = useRef<HTMLSpanElement>(null);
  const [widths, setWidths] = useState<{ idle: number; copied: number } | null>(null);
  const widthsRef = useRef(widths);

  useLayoutEffect(() => {
    const idle = idleRef.current;
    const copied = copiedRef.current;
    if (!idle || !copied) {
      return;
    }
    /** `offsetWidth` ignores the dialog's open-animation scale, which would otherwise
     *  bake a shrunken width in. It rounds to whole pixels, so add one back to keep
     *  sub-pixel text from tripping the ellipsis. */
    const measure = () => {
      const next = { idle: idle.offsetWidth + 1, copied: copied.offsetWidth + 1 };
      if (next.idle <= 1 || next.copied <= 1) {
        return;
      }
      const previous = widthsRef.current;
      if (previous && previous.idle === next.idle && previous.copied === next.copied) {
        return;
      }
      widthsRef.current = next;
      setWidths(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(idle);
    observer.observe(copied);
    return () => observer.disconnect();
  }, [idleLabel, copiedLabel]);

  const handleCopy = useCallback(async () => {
    if (disabled) {
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      clearTimeout(resetTimerRef.current);
      setIsCopied(true);
      resetTimerRef.current = setTimeout(() => setIsCopied(false), RESET_MS);
    } catch {
      showToast({ message: localize('com_agents_link_copy_failed') });
    }
  }, [disabled, localize, showToast, url]);

  const width = widths?.[isCopied ? 'copied' : 'idle'];

  return (
    <>
      <Button
        variant="outline"
        size="dense"
        className="min-w-0"
        onClick={handleCopy}
        aria-disabled={disabled || undefined}
        aria-label={isCopied ? copiedLabel : idleLabel}
      >
        <MorphIcon icon={isCopied ? Check : Link} size={16} className="shrink-0" />
        <span
          aria-hidden="true"
          style={width == null ? undefined : { width }}
          className="grid max-w-full overflow-hidden text-start transition-all duration-300 ease-out motion-reduce:transition-none"
        >
          <span
            className={cn(
              LABEL_CLASSES,
              isCopied ? '-translate-y-full opacity-0' : 'translate-y-0 opacity-100',
            )}
          >
            <span ref={idleRef} className="block w-max">
              {idleLabel}
            </span>
          </span>
          <span
            className={cn(
              LABEL_CLASSES,
              isCopied ? 'translate-y-0 opacity-100' : 'translate-y-full opacity-0',
            )}
          >
            <span ref={copiedRef} className="block w-max">
              {copiedLabel}
            </span>
          </span>
        </span>
      </Button>
      <span role="status" className="sr-only">
        {isCopied ? copiedLabel : ''}
      </span>
    </>
  );
}
