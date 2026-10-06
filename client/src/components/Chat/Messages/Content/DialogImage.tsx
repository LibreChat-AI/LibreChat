import { useState, useEffect, useCallback, useRef } from 'react';
import { PanelLeftOpen, PanelLeftClose } from 'lucide';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X, ArrowDownToLine, RotateCcw } from 'lucide-react';
import { Button, MorphIcon, TooltipAnchor, useMediaQuery, useRemScale } from '@librechat/client';
import { useLocalize } from '~/hooks';

/** The lightbox is z-250 and not an OGDialog, so its tooltips would keep the default 150 and sit behind it. */
const TOOLTIP_Z_INDEX = 300;

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
  showDetails = true,
  title,
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
  /** Off for an uploaded file, which has no generation details to show. */
  showDetails?: boolean;
  /** Names the dialog and the image for assistive tech, e.g. the file name. */
  title?: string;
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

  /* The details panel is 20rem wide, so the viewport it has to fit beside has to be
     measured in the same units: a fixed 640px breakpoint puts the panel beside the
     image at scales where 20rem leaves almost nothing for the image and pushes the
     action controls offscreen. Below it the panel overlays instead, as on mobile. */
  const remScale = useRemScale();
  const detailsFitBesideImage = useMediaQuery(`(min-width: ${640 * remScale}px)`);
  const detailsBeside = isPromptOpen && detailsFitBesideImage;

  // Reserve the side panel's width (w-80 = 20rem) only when it sits beside the image
  const getImageMaxWidth = () => (detailsBeside ? 'calc(90vw - 20rem)' : '90vw');

  return (
    <DialogPrimitive.Root open={isOpen} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className="bg-surface-media-overlay/90 fixed inset-0 z-[250]"
          onClick={handleBackgroundClick}
        />
        <DialogPrimitive.Content
          className="fixed inset-0 z-[250] flex items-center justify-center outline-hidden"
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
          {title != null && (
            <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
          )}
          {/* Close button - top left */}
          <div className="absolute top-4 left-4 z-20">
            <TooltipAnchor
              zIndex={TOOLTIP_Z_INDEX}
              description={localize('com_ui_close')}
              render={
                <Button
                  ref={closeButtonRef}
                  onClick={() => onOpenChange(false)}
                  variant="media"
                  className="h-10 w-10 p-0"
                  aria-label={localize('com_ui_close')}
                >
                  <X className="size-6" aria-hidden="true" />
                </Button>
              }
            />
          </div>

          {/* Action buttons - top right (21rem = 20rem panel + 1rem gap) */}
          <div
            className={`absolute top-4 z-20 flex items-center gap-2 transition-[right] duration-300 ${detailsBeside ? 'right-[21rem]' : 'right-4'}`}
          >
            {zoom > 1 && (
              <TooltipAnchor
                zIndex={TOOLTIP_Z_INDEX}
                description={localize('com_ui_reset_zoom')}
                render={
                  <Button
                    onClick={resetZoom}
                    variant="media"
                    className="h-10 w-10 p-0"
                    aria-label={localize('com_ui_reset_zoom')}
                  >
                    <RotateCcw className="size-5" aria-hidden="true" />
                  </Button>
                }
              />
            )}
            <TooltipAnchor
              zIndex={TOOLTIP_Z_INDEX}
              description={localize('com_ui_download')}
              render={
                <Button
                  onClick={() => downloadImage()}
                  variant="media"
                  className="h-10 w-10 p-0"
                  aria-label={localize('com_ui_download')}
                >
                  <ArrowDownToLine className="size-5" aria-hidden="true" />
                </Button>
              }
            />
            {showDetails && (
              <TooltipAnchor
                zIndex={TOOLTIP_Z_INDEX}
                description={imageDetailsLabel}
                render={
                  <Button
                    onClick={() => setIsPromptOpen(!isPromptOpen)}
                    variant="media"
                    className="h-10 w-10 p-0"
                    aria-label={imageDetailsLabel}
                  >
                    <MorphIcon
                      icon={isPromptOpen ? PanelLeftOpen : PanelLeftClose}
                      className="size-5"
                    />
                  </Button>
                }
              />
            )}
          </div>

          {/* Image container - centered */}
          <div
            className={`transition-[margin] duration-300 ${detailsBeside ? 'mr-80' : ''}`}
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
                  alt={title ?? 'Image'}
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
          {showDetails && (
            <div
              data-side-panel
              className={`bg-surface-primary border-text-on-media/10 fixed top-0 right-0 z-30 h-full w-80 max-w-full transform border-l shadow-2xl transition-transform duration-300 ${
                isPromptOpen ? 'translate-x-0' : 'translate-x-full'
              }`}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="h-full overflow-y-auto p-6">
                <div className="mb-4 flex items-center justify-between">
                  <h3 className="text-text-primary text-lg font-semibold">
                    {localize('com_ui_image_details')}
                  </h3>
                  <Button
                    onClick={() => setIsPromptOpen(false)}
                    variant="ghost"
                    className={detailsBeside ? 'hidden' : 'h-10 w-10 p-0'}
                    aria-label={localize('com_ui_hide_image_details')}
                  >
                    <X className="size-5" aria-hidden="true" />
                  </Button>
                </div>
                <div className="bg-border-medium mb-4 h-px"></div>

                <div className="space-y-6">
                  {/* Prompt Section */}
                  <div>
                    <h4 className="text-text-primary mb-2 text-sm font-medium">
                      {localize('com_ui_prompt')}
                    </h4>
                    <div className="bg-surface-tertiary rounded-md p-3">
                      <p className="text-text-primary text-sm leading-relaxed">
                        {args?.prompt || 'No prompt available'}
                      </p>
                    </div>
                  </div>

                  {/* Generation Settings */}
                  <div>
                    <h4 className="text-text-primary mb-3 text-sm font-medium">
                      {localize('com_ui_generation_settings')}
                    </h4>
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <span className="text-text-primary text-sm">
                          {localize('com_ui_size')}:
                        </span>
                        <span className="text-text-primary text-sm font-medium">
                          {args?.size || 'Unknown'}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-text-primary text-sm">
                          {localize('com_ui_quality')}:
                        </span>
                        <span
                          className={`rounded px-2 py-1 text-xs font-medium capitalize ${getQualityStyles(args?.quality || '')}`}
                        >
                          {args?.quality || 'Standard'}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-text-primary text-sm">
                          {localize('com_ui_file_size')}:
                        </span>
                        <span className="text-text-primary text-sm font-medium">
                          {imageSize || 'Loading...'}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
