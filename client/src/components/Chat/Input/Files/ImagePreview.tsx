import { useState, useEffect, useCallback, useRef } from 'react';
import { Button } from '@librechat/client';
import { Maximize2, X } from 'lucide-react';
import { FileSources } from 'librechat-data-provider';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import ProgressCircle from './ProgressCircle';
import SourceIcon from './SourceIcon';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

type styleProps = {
  backgroundImage?: string;
  backgroundSize?: string;
  backgroundPosition?: string;
  backgroundRepeat?: string;
};

const ImagePreview = ({
  imageBase64,
  url,
  progress = 1,
  className = '',
  source,
  alt = 'Preview image',
}: {
  imageBase64?: string;
  url?: string;
  progress?: number;
  className?: string;
  source?: FileSources;
  alt?: string;
}) => {
  const localize = useLocalize();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  const openModal = useCallback(() => {
    setIsModalOpen(true);
  }, []);

  const handleOpenChange = useCallback((open: boolean) => {
    setIsModalOpen(open);
    if (!open && triggerRef.current) {
      requestAnimationFrame(() => {
        triggerRef.current?.focus({ preventScroll: true });
      });
    }
  }, []);

  // Handle click on background areas to close (only if clicking the overlay/content directly)
  const handleBackgroundClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget) {
        handleOpenChange(false);
      }
    },
    [handleOpenChange],
  );

  useEffect(() => {
    if (isModalOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = 'unset';
    }

    return () => {
      document.body.style.overflow = 'unset';
    };
  }, [isModalOpen]);

  // Handle escape key
  useEffect(() => {
    if (!isModalOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleOpenChange(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isModalOpen, handleOpenChange]);

  const baseStyle: styleProps = {
    backgroundSize: 'cover',
    backgroundPosition: 'center',
    backgroundRepeat: 'no-repeat',
  };

  const imageUrl = imageBase64 ?? url ?? '';

  const style: styleProps = imageUrl
    ? {
        ...baseStyle,
        backgroundImage: `url(${imageUrl})`,
      }
    : baseStyle;

  if (typeof style.backgroundImage !== 'string' || style.backgroundImage.length === 0) {
    return null;
  }

  const radius = 55;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - progress * circumference;
  const circleCSSProperties = {
    transition: 'stroke-dashoffset 0.3s linear',
  };

  /** Keyboard users need the same expand affordance the pointer gets on hover. */
  const showExpandAffordance = isHovered || isFocused;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={cn(
          'relative size-14 overflow-hidden rounded-xl transition-shadow',
          'focus-visible:ring-text-primary focus-visible:ring-offset-surface-primary focus:outline-hidden focus-visible:ring-2 focus-visible:ring-offset-2',
          className,
        )}
        style={style}
        aria-label={`View ${alt} in full size`}
        aria-haspopup="dialog"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          openModal();
        }}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        onFocus={() => setIsFocused(true)}
        onBlur={() => setIsFocused(false)}
      >
        {progress < 1 ? (
          <ProgressCircle
            circumference={circumference}
            offset={offset}
            circleCSSProperties={circleCSSProperties}
            aria-label={`Loading progress: ${Math.round(progress * 100)}%`}
          />
        ) : (
          <div
            className={cn(
              'absolute inset-0 flex transform-gpu cursor-pointer items-center justify-center rounded-xl transition-opacity duration-200 ease-in-out',
              showExpandAffordance ? 'bg-surface-media-overlay/20 opacity-100' : 'opacity-0',
            )}
            aria-hidden="true"
          >
            <Maximize2
              className={cn(
                'text-text-on-media size-5 transform-gpu drop-shadow-lg transition-all duration-200',
                showExpandAffordance ? 'scale-110' : '',
              )}
            />
          </div>
        )}
        <SourceIcon source={source} aria-label={source ? `Source: ${source}` : undefined} />
      </button>

      <DialogPrimitive.Root open={isModalOpen} onOpenChange={handleOpenChange}>
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
              triggerRef.current?.focus();
            }}
            onPointerDownOutside={(e) => e.preventDefault()}
            onClick={handleBackgroundClick}
          >
            {/* Close button */}
            <Button
              ref={closeButtonRef}
              onClick={() => handleOpenChange(false)}
              variant="media"
              size="icon"
              className="absolute top-4 right-4 z-20"
              aria-label={localize('com_ui_close')}
            >
              <X className="size-5" aria-hidden="true" />
            </Button>

            {/* Image container */}
            <div onClick={(e) => e.stopPropagation()}>
              <img
                ref={imageRef}
                src={imageUrl}
                alt={alt}
                className="max-h-[85vh] max-w-[90vw] object-contain"
                draggable={false}
              />
            </div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </>
  );
};

export default ImagePreview;
