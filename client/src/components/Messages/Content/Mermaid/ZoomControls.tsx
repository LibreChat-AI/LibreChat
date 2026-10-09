import React, { memo, useState, useCallback, useRef, useEffect } from 'react';
import copy from 'copy-to-clipboard';
import { Copy, Check } from 'lucide';
import { MorphIcon } from '@librechat/client';
import { ZoomIn, ZoomOut, RotateCcw } from 'lucide-react';
import { MIN_ZOOM, MAX_ZOOM } from './useMermaidZoom';
import { useLocalize } from '~/hooks';
import cn from '~/utils/cn';

interface ZoomControlsProps {
  zoom: number;
  pan: { x: number; y: number };
  codeContent: string;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onReset: () => void;
  className?: string;
}

const btnClass =
  'rounded p-1.5 text-text-secondary hover:bg-surface-hover disabled:opacity-40 disabled:hover:bg-transparent';

const ZoomControls: React.FC<ZoomControlsProps> = memo(
  ({ zoom, pan, codeContent, onZoomIn, onZoomOut, onReset, className }) => {
    const localize = useLocalize();
    const [isCopied, setIsCopied] = useState(false);
    const copyRef = useRef<HTMLButtonElement>(null);
    const copyTimerRef = useRef<ReturnType<typeof setTimeout>>();

    useEffect(() => {
      return () => clearTimeout(copyTimerRef.current);
    }, []);

    const handleCopy = useCallback(() => {
      copy(codeContent.trim(), { format: 'text/plain' });
      setIsCopied(true);
      requestAnimationFrame(() => copyRef.current?.focus());
      clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => {
        setIsCopied(false);
        requestAnimationFrame(() => copyRef.current?.focus());
      }, 3000);
    }, [codeContent]);

    const stop =
      (fn: () => void) =>
      (e: React.MouseEvent): void => {
        e.stopPropagation();
        fn();
      };

    return (
      <div
        className={cn(
          'flex items-center gap-1 rounded-lg border border-border-light bg-surface-secondary p-1 shadow-md',
          className,
        )}
      >
        <button
          type="button"
          onClick={stop(onZoomOut)}
          disabled={zoom <= MIN_ZOOM}
          className={btnClass}
          title={localize('com_ui_zoom_out')}
        >
          <ZoomOut className="h-4 w-4" />
        </button>
        <span className="min-w-[3rem] text-center text-xs text-text-secondary">
          {Math.round(zoom * 100)}%
        </span>
        <button
          type="button"
          onClick={stop(onZoomIn)}
          disabled={zoom >= MAX_ZOOM}
          className={btnClass}
          title={localize('com_ui_zoom_in')}
        >
          <ZoomIn className="h-4 w-4" />
        </button>
        <div className="mx-1 h-4 w-px bg-border-medium" />
        <button
          type="button"
          onClick={stop(onReset)}
          disabled={zoom === 1 && pan.x === 0 && pan.y === 0}
          className={btnClass}
          title={localize('com_ui_reset_zoom')}
        >
          <RotateCcw className="h-4 w-4" />
        </button>
        <div className="mx-1 h-4 w-px bg-border-medium" />
        <button
          ref={copyRef}
          type="button"
          onClick={stop(handleCopy)}
          className="rounded p-1.5 text-text-secondary hover:bg-surface-hover"
          title={localize('com_ui_copy_code')}
        >
          <MorphIcon icon={isCopied ? Check : Copy} className="h-4 w-4" />
        </button>
      </div>
    );
  },
);

ZoomControls.displayName = 'ZoomControls';

export default ZoomControls;
