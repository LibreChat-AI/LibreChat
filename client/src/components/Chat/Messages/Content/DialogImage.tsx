import { useState, useEffect, useCallback, useRef } from 'react';
import { PanelLeftOpen, PanelLeftClose } from 'lucide';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X, ArrowDownToLine, RotateCcw } from 'lucide-react';
import { Button, MorphIcon, TooltipAnchor } from '@librechat/client';
import { useLocalize } from '~/hooks';

const imageSizeCache = new Map<string, string>();

const getQualityStyles = (quality: string): string => {
  if (quality === 'high') {
    return 'bg-status-success-subtle text-status-success';
  }
  if (quality === 'low') {
    return 'bg-status-warning-subtle text-status-warning';
  }
  return 'bg-status-neutral-subtle text-status-neutral';
};

export default function DialogImage({
  isOpen,
  onOpenChange,
  src = '',
  downloadImage,
  args,
  triggerRef,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  src?: string;
  downloadImage: () => void;
  args?: {
    prompt?: string;
    quality?: string;
    size?: string;
    [key: string]: unknown;
  };
  triggerRef?: React.RefObject<HTMLButtonElement>;
}) {
  const localize = useLocalize();
  const [isPromptOpen, setIsPromptOpen] = useState(false);
  const [imageSize, setImageSize] = useState<string | null>(null);

  // Zoom and pan state
  const [zoom, setZoom] = useState(1);
  const [panX, setPanX] = useState(0);
  const [panY, setPanY] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });

  const containerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  const getImageSize = useCallback(async (url: string) => {
    const cached = imageSizeCache.get(url);
    if (cached) {
      return cached;
    }
    try {
      const response = await fetch(url, { method: 'HEAD' });
      const contentLength = response.headers.get('Content-Length');

      if (contentLength) {
        const bytes = parseInt(contentLength, 10);
        const result = formatFileSize(bytes);
        imageSizeCache.set(url, result);
        return result;
      }

      const fullResponse = await fetch(url);
      const blob = await fullResponse.blob();
      const result = formatFileSize(blob.size);
      imageSizeCache.set(url, result);
      return result;
    } catch (error) {
      console.error('Error getting image size:', error);
      return null;
    }
  }, []);

  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 Bytes';

    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const resetZoom = useCallback(() => {
    setZoom(1);
    setPanX(0);
    setPanY(0);
  }, []);

  const getCursor = () => {
    if (zoom <= 1) return 'default';
    return isDragging ? 'grabbing' : 'grab';
  };

  const handleDoubleClick = useCallback(() => {
    if (zoom > 1) {
      resetZoom();
    } else {
      setZoom(2);
    }
  }, [zoom, resetZoom]);

  const handleWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      e.preventDefault();
      if (!containerRef.current) return;

      const rect = containerRef.current.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
      const newZoom = Math.min(Math.max(zoom * zoomFactor, 1), 5);

      if (newZoom === zoom) return;

      if (newZoom === 1) {
        setZoom(1);
        setPanX(0);
        setPanY(0);
        return;
      }

      const containerCenterX = rect.width / 2;
      const containerCenterY = rect.height / 2;

      const zoomRatio = newZoom / zoom;
      const deltaX = (mouseX - containerCenterX - panX) * (zoomRatio - 1);
      const deltaY = (mouseY - containerCenterY - panY) * (zoomRatio - 1);

      setZoom(newZoom);
      setPanX(panX - deltaX);
      setPanY(panY - deltaY);
    },
    [zoom, panX, panY],
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      if (zoom <= 1) return;
      setIsDragging(true);
      setDragStart({
        x: e.clientX - panX,
        y: e.clientY - panY,
      });
    },
    [zoom, panX, panY],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!isDragging || zoom <= 1) return;
      const newPanX = e.clientX - dragStart.x;
      const newPanY = e.clientY - dragStart.y;
      setPanX(newPanX);
      setPanY(newPanY);
    },
    [isDragging, dragStart, zoom],
  );

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  // Handle click on empty areas to close (only if clicking overlay/content directly, not children)
  const handleBackgroundClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      // Only close if clicking directly on overlay/content background
      if (e.target !== e.currentTarget) {
        return;
      }
      // Don't close if zoomed (user might be panning)
      if (zoom > 1) {
        return;
      }
      onOpenChange(false);
    },
    [onOpenChange, zoom],
  );

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (zoom > 1) {
          resetZoom();
        } else {
          onOpenChange(false);
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [resetZoom, onOpenChange, isOpen, zoom]);

  useEffect(() => {
    if (isOpen && src) {
      getImageSize(src).then(setImageSize);
      resetZoom();
    }
  }, [isOpen, src, getImageSize, resetZoom]);

  useEffect(() => {
    if (zoom === 1) {
      setPanX(0);
      setPanY(0);
    }
  }, [zoom]);

  useEffect(() => {
    if (zoom === 1) {
      setPanX(0);
      setPanY(0);
    }
  }, [isPromptOpen, zoom]);

  // Lock body scroll when dialog is open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [isOpen]);

  const imageDetailsLabel = isPromptOpen
    ? localize('com_ui_hide_image_details')
    : localize('com_ui_show_image_details');

  // Calculate image max dimensions accounting for side panel (w-80 = 320px)
  const getImageMaxWidth = () => {
    if (isPromptOpen) {
      // On mobile, panel overlays so use full width; on desktop, subtract panel width
      return typeof window !== 'undefined' && window.innerWidth >= 640
        ? 'calc(90vw - 320px)'
        : '90vw';
    }
    return '90vw';
  };

  return (
    <DialogPrimitive.Root open={isOpen} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className="fixed inset-0 z-[100] bg-black/90"
          onClick={handleBackgroundClick}
        />
        <DialogPrimitive.Content
          className="fixed inset-0 z-[100] flex items-center justify-center outline-none"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            closeButtonRef.current?.focus();
          }}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            triggerRef?.current?.focus();
          }}
          onPointerDownOutside={(e) => e.preventDefault()}
          onClick={handleBackgroundClick}
        >
          {/* Close button - top left */}
          <div className="absolute left-4 top-4 z-20">
            <TooltipAnchor
              description={localize('com_ui_close')}
              render={
                <Button
                  ref={closeButtonRef}
                  onClick={() => onOpenChange(false)}
                  variant="ghost"
                  className="h-10 w-10 p-0 text-white hover:bg-white/10"
                  aria-label={localize('com_ui_close')}
                >
                  <X className="size-6" aria-hidden="true" />
                </Button>
              }
            />
          </div>

          {/* Action buttons - top right (336px = 320px panel + 16px gap) */}
          <div
            className={`absolute top-4 z-20 flex items-center gap-2 transition-[right] duration-300 ${isPromptOpen ? 'right-[336px]' : 'right-4'}`}
          >
            {zoom > 1 && (
              <TooltipAnchor
                description={localize('com_ui_reset_zoom')}
                render={
                  <Button
                    onClick={resetZoom}
                    variant="ghost"
                    className="h-10 w-10 p-0 text-white hover:bg-white/10"
                    aria-label={localize('com_ui_reset_zoom')}
                  >
                    <RotateCcw className="size-5" aria-hidden="true" />
                  </Button>
                }
              />
            )}
            <TooltipAnchor
              description={localize('com_ui_download')}
              render={
                <Button
                  onClick={() => downloadImage()}
                  variant="ghost"
                  className="h-10 w-10 p-0 text-white hover:bg-white/10"
                  aria-label={localize('com_ui_download')}
                >
                  <ArrowDownToLine className="size-5" aria-hidden="true" />
                </Button>
              }
            />
            <TooltipAnchor
              description={imageDetailsLabel}
              render={
                <Button
                  onClick={() => setIsPromptOpen(!isPromptOpen)}
                  variant="ghost"
                  className="h-10 w-10 p-0 text-white hover:bg-white/10"
                  aria-label={imageDetailsLabel}
                >
                  <MorphIcon
                    icon={isPromptOpen ? PanelLeftOpen : PanelLeftClose}
                    className="size-5"
                  />
                </Button>
              }
            />
          </div>

          {/* Image container - centered */}
          <div
            className={`transition-[margin] duration-300 ${isPromptOpen ? 'mr-80' : ''}`}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              ref={containerRef}
              className="relative"
              onWheel={handleWheel}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseUp}
              onDoubleClick={handleDoubleClick}
              style={{ cursor: getCursor() }}
            >
              <div
                className="transition-transform duration-100 ease-out"
                style={{
                  transform: `translate(${panX}px, ${panY}px) scale(${zoom})`,
                  transformOrigin: 'center center',
                }}
              >
                <img
                  ref={imageRef}
                  src={src}
                  alt="Image"
                  decoding="async"
                  className="block max-h-[85vh] object-contain"
                  style={{
                    maxWidth: getImageMaxWidth(),
                  }}
                  draggable={false}
                />
              </div>
            </div>
          </div>

          {/* Side Panel */}
          <div
            data-side-panel
            className={`fixed right-0 top-0 z-30 h-full w-80 transform border-l border-white/10 bg-surface-primary shadow-2xl transition-transform duration-300 ${
              isPromptOpen ? 'translate-x-0' : 'translate-x-full'
            }`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="h-full overflow-y-auto p-6">
              <div className="mb-4 flex items-center justify-between">
                <h3 className="text-lg font-semibold text-text-primary">
                  {localize('com_ui_image_details')}
                </h3>
                <Button
                  onClick={() => setIsPromptOpen(false)}
                  variant="ghost"
                  className="h-10 w-10 p-0 sm:hidden"
                >
                  <X className="size-5" aria-hidden="true" />
                </Button>
              </div>
              <div className="mb-4 h-px bg-border-medium"></div>

              <div className="space-y-6">
                {/* Prompt Section */}
                <div>
                  <h4 className="mb-2 text-sm font-medium text-text-primary">
                    {localize('com_ui_prompt')}
                  </h4>
                  <div className="rounded-md bg-surface-tertiary p-3">
                    <p className="text-sm leading-relaxed text-text-primary">
                      {args?.prompt || 'No prompt available'}
                    </p>
                  </div>
                </div>

                {/* Generation Settings */}
                <div>
                  <h4 className="mb-3 text-sm font-medium text-text-primary">
                    {localize('com_ui_generation_settings')}
                  </h4>
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-text-primary">{localize('com_ui_size')}:</span>
                      <span className="text-sm font-medium text-text-primary">
                        {args?.size || 'Unknown'}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-text-primary">
                        {localize('com_ui_quality')}:
                      </span>
                      <span
                        className={`rounded px-2 py-1 text-xs font-medium capitalize ${getQualityStyles(args?.quality || '')}`}
                      >
                        {args?.quality || 'Standard'}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-text-primary">
                        {localize('com_ui_file_size')}:
                      </span>
                      <span className="text-sm font-medium text-text-primary">
                        {imageSize || 'Loading...'}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
