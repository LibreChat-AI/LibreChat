import React, { memo, useState, useCallback, useRef, useEffect } from 'react';
import { Eye, Code2 } from 'lucide';
import copy from 'copy-to-clipboard';
import { Expand } from 'lucide-react';
import { MorphIcon, TooltipAnchor } from '@librechat/client';
import type { MermaidDimensions } from '~/utils/diagram/export';
import CopyButton from '~/components/Messages/Content/CopyButton';
import { useLocalize } from '~/hooks';
import MermaidExport from './Export';
import cn from '~/utils/cn';

interface MermaidHeaderProps {
  className?: string;
  actionsClassName?: string;
  codeContent: string;
  showCode: boolean;
  showExpandButton?: boolean;
  expandButtonRef?: React.RefObject<HTMLButtonElement>;
  expandLabel?: string;
  exportSvg?: string | null;
  exportDimensions?: MermaidDimensions | null;
  exportFilename?: string;
  onExpand?: () => void;
  onToggleCode: () => void;
}

const iconBtnClass =
  'flex items-center justify-center rounded-lg p-1.5 text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-border-heavy';

const MermaidHeader: React.FC<MermaidHeaderProps> = memo(
  ({
    className,
    actionsClassName,
    codeContent,
    showCode,
    showExpandButton = false,
    expandButtonRef,
    expandLabel,
    exportSvg,
    exportDimensions,
    exportFilename,
    onExpand,
    onToggleCode,
  }) => {
    const localize = useLocalize();
    const toggleLabel = showCode ? localize('com_ui_preview') : localize('com_ui_show_code');
    const [isCopied, setIsCopied] = useState(false);
    const copyButtonRef = useRef<HTMLButtonElement>(null);
    const showCodeButtonRef = useRef<HTMLButtonElement>(null);
    const copyTimerRef = useRef<ReturnType<typeof setTimeout>>();

    useEffect(() => {
      return () => clearTimeout(copyTimerRef.current);
    }, []);

    const handleCopy = useCallback(() => {
      copy(codeContent.trim(), { format: 'text/plain' });
      setIsCopied(true);
      clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setIsCopied(false), 3000);
    }, [codeContent]);

    const handleToggleCode = useCallback(() => {
      onToggleCode();
      requestAnimationFrame(() => {
        showCodeButtonRef.current?.focus();
      });
    }, [onToggleCode]);

    return (
      <div className={cn('flex items-center justify-between gap-1 px-2 py-1', className)}>
        <span className="rounded text-xs font-medium text-text-secondary">
          {localize('com_ui_mermaid')}
        </span>
        <div className={cn('flex items-center gap-1', actionsClassName)}>
          {showExpandButton && onExpand && (
            <TooltipAnchor
              description={expandLabel ?? localize('com_ui_expand')}
              render={
                <button
                  ref={expandButtonRef}
                  type="button"
                  aria-label={expandLabel ?? localize('com_ui_expand')}
                  className={iconBtnClass}
                  onClick={onExpand}
                >
                  <Expand className="h-4 w-4" aria-hidden="true" />
                </button>
              }
            />
          )}
          {exportSvg != null && exportFilename != null && (
            <MermaidExport
              svg={exportSvg}
              dimensions={exportDimensions}
              filename={exportFilename}
            />
          )}
          <TooltipAnchor
            description={toggleLabel}
            render={
              <button
                ref={showCodeButtonRef}
                type="button"
                aria-label={toggleLabel}
                aria-pressed={showCode}
                className={iconBtnClass}
                onClick={handleToggleCode}
              >
                <MorphIcon icon={showCode ? Eye : Code2} className="h-4 w-4" />
              </button>
            }
          />
          <CopyButton ref={copyButtonRef} isCopied={isCopied} iconOnly onClick={handleCopy} />
        </div>
      </div>
    );
  },
);

MermaidHeader.displayName = 'MermaidHeader';

export default MermaidHeader;
