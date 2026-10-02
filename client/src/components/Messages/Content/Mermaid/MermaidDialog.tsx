import React, { memo, useState, useCallback, useRef, useEffect } from 'react';
import { X } from 'lucide-react';
import copy from 'copy-to-clipboard';
import { Copy, Check, ChevronUp, ChevronDown } from 'lucide';
import {
  Button,
  OGDialog,
  MorphIcon,
  OGDialogClose,
  OGDialogTitle,
  OGDialogContent,
} from '@librechat/client';
import type { MermaidDimensions } from '~/utils/diagram/export';
import useMermaidZoom from './useMermaidZoom';
import ZoomControls from './ZoomControls';
import { useLocalize } from '~/hooks';
import MermaidExport from './Export';
import cn from '~/utils/cn';

interface MermaidDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerRef: React.RefObject<HTMLButtonElement>;
  blobUrl: string;
  codeContent: string;
  exportSvg: string | null;
  exportDimensions: MermaidDimensions | null;
  exportFilename: string;
}

const MermaidDialog: React.FC<MermaidDialogProps> = memo(
  ({
    open,
    onOpenChange,
    triggerRef,
    blobUrl,
    codeContent,
    exportSvg,
    exportDimensions,
    exportFilename,
  }) => {
    const localize = useLocalize();
    const [showCode, setShowCode] = useState(false);
    const [isCopied, setIsCopied] = useState(false);
    const showCodeButtonRef = useRef<HTMLButtonElement>(null);
    const copyButtonRef = useRef<HTMLButtonElement>(null);
    const copyTimerRef = useRef<ReturnType<typeof setTimeout>>();

    const {
      zoom,
      pan,
      isPanning,
      handleZoomIn,
      handleZoomOut,
      handleResetZoom,
      handleWheel,
      handleMouseDown,
    } = useMermaidZoom();

    useEffect(() => {
      if (open) {
        setShowCode(false);
        handleResetZoom();
      }
    }, [open, handleResetZoom]);

    const handleToggleCode = useCallback(() => {
      setShowCode((prev) => !prev);
      requestAnimationFrame(() => showCodeButtonRef.current?.focus());
    }, []);

    const handleCopy = useCallback(() => {
      copy(codeContent.trim(), { format: 'text/plain' });
      setIsCopied(true);
      requestAnimationFrame(() => copyButtonRef.current?.focus());
      clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => {
        setIsCopied(false);
        requestAnimationFrame(() => copyButtonRef.current?.focus());
      }, 3000);
    }, [codeContent]);

    return (
      <OGDialog open={open} onOpenChange={onOpenChange} triggerRef={triggerRef}>
        <OGDialogContent
          showCloseButton={false}
          className="border-border-light bg-surface-dialog h-[85vh] max-h-[85vh] w-[90vw] max-w-[90vw] gap-0 overflow-hidden p-0"
        >
          <OGDialogTitle className="border-border-light bg-surface-secondary text-text-secondary flex h-10 items-center justify-between border-b px-4 font-sans text-xs">
            <span>{localize('com_ui_mermaid')}</span>
            <div className="flex gap-1 sm:gap-2">
              <MermaidExport
                svg={exportSvg}
                dimensions={exportDimensions}
                filename={exportFilename}
                buttonClassName="h-8 w-8 p-0"
              />
              <Button
                ref={showCodeButtonRef}
                variant="ghost"
                size="sm"
                aria-label={showCode ? localize('com_ui_hide_code') : localize('com_ui_show_code')}
                className="text-text-secondary hover:bg-surface-hover hover:text-text-primary focus-visible:ring-border-heavy size-8 min-w-0 gap-1 rounded-sm p-0 text-xs focus-visible:ring-offset-0 sm:h-auto sm:w-auto sm:min-w-[6rem] sm:px-1 sm:py-0"
                onClick={handleToggleCode}
              >
                <MorphIcon icon={showCode ? ChevronUp : ChevronDown} className="h-4 w-4" />
                <span className="hidden sm:inline">
                  {showCode ? localize('com_ui_hide_code') : localize('com_ui_show_code')}
                </span>
              </Button>
              <Button
                ref={copyButtonRef}
                variant="ghost"
                size="sm"
                aria-label={localize('com_ui_copy_code')}
                className="text-text-secondary hover:bg-surface-hover hover:text-text-primary focus-visible:ring-border-heavy size-8 min-w-0 gap-1 rounded-sm p-0 text-xs focus-visible:ring-offset-0 sm:h-auto sm:w-auto sm:px-1 sm:py-0"
                onClick={handleCopy}
              >
                <MorphIcon icon={isCopied ? Check : Copy} size={18} />
                <span className="hidden sm:inline">{localize('com_ui_copy_code')}</span>
              </Button>
              <OGDialogClose
                focusOutline="hidden"
                className="text-text-secondary hover:bg-surface-hover hover:text-text-primary focus-visible:ring-border-heavy rounded-sm p-1 focus-visible:ring-2"
              >
                <X className="h-4 w-4" />
                <span className="sr-only">{localize('com_ui_close')}</span>
              </OGDialogClose>
            </div>
          </OGDialogTitle>
          {showCode && (
            <div className="border-border-light bg-surface-secondary border-b p-4">
              <pre className="text-text-secondary max-h-[150px] overflow-auto text-xs whitespace-pre-wrap">
                {codeContent}
              </pre>
            </div>
          )}
          <div
            className={cn(
              'bg-surface-primary-alt relative flex-1 overflow-hidden p-4',
              isPanning ? 'cursor-grabbing' : 'cursor-grab',
            )}
            style={{ height: showCode ? 'calc(85vh - 200px)' : 'calc(85vh - 50px)' }}
            onWheel={handleWheel}
            onMouseDown={handleMouseDown}
          >
            <div
              className="flex h-full w-full items-center justify-center"
              style={{
                transform: `translate(${pan.x}px, ${pan.y}px)`,
                transition: isPanning ? 'none' : 'transform 0.1s ease-out',
              }}
            >
              <img
                src={blobUrl}
                alt={localize('com_ui_mermaid_diagram')}
                className="max-h-full max-w-full object-contain select-none"
                style={{
                  transform: `scale(${zoom})`,
                  transformOrigin: 'center center',
                }}
                draggable={false}
              />
            </div>
            <ZoomControls
              zoom={zoom}
              pan={pan}
              codeContent={codeContent}
              onZoomIn={handleZoomIn}
              onZoomOut={handleZoomOut}
              onReset={handleResetZoom}
              className="absolute right-4 bottom-4 z-10"
            />
          </div>
        </OGDialogContent>
      </OGDialog>
    );
  },
);

MermaidDialog.displayName = 'MermaidDialog';

export default MermaidDialog;
