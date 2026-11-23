import React, { useState } from 'react';
import { Button } from '@librechat/client';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { UIResource } from 'librechat-data-provider';
import UIResourceRenderer, { isSupportedUIResource } from '~/components/MCPUIResource/Renderer';
import { useMessagePartsHost } from '~/Providers/MessagePartsHostContext';
import { cn, handleUIAction } from '~/utils';
import { useLocalize } from '~/hooks';

interface UIResourceCarouselProps {
  uiResources: UIResource[];
}

const UIResourceCarousel: React.FC<UIResourceCarouselProps> = React.memo(({ uiResources }) => {
  const localize = useLocalize();
  const [showLeftArrow, setShowLeftArrow] = useState(false);
  const [showRightArrow, setShowRightArrow] = useState(true);
  const [isContainerHovered, setIsContainerHovered] = useState(false);
  const scrollContainerRef = React.useRef<HTMLDivElement>(null);
  const ask = useMessagePartsHost().useMessagesAsk();
  const supportedUIResources = React.useMemo(
    () => uiResources.filter(isSupportedUIResource),
    [uiResources],
  );

  const handleScroll = React.useCallback(() => {
    if (!scrollContainerRef.current) return;

    const container = scrollContainerRef.current;
    const { scrollLeft, scrollWidth, clientWidth } = container;
    /** In RTL `scrollLeft` is 0 at the right edge and negative toward the left; normalize to the offset from the left edge. */
    const maxScroll = scrollWidth - clientWidth;
    const fromLeft =
      getComputedStyle(container).direction === 'rtl' ? maxScroll + scrollLeft : scrollLeft;
    setShowLeftArrow(fromLeft > 0);
    setShowRightArrow(fromLeft < maxScroll - 10);
  }, []);

  const scroll = React.useCallback((direction: 'left' | 'right') => {
    if (!scrollContainerRef.current) return;

    const viewportWidth = scrollContainerRef.current.clientWidth;
    const scrollAmount = Math.floor(viewportWidth * 0.9);
    const currentScroll = scrollContainerRef.current.scrollLeft;
    const newScroll =
      direction === 'left' ? currentScroll - scrollAmount : currentScroll + scrollAmount;

    scrollContainerRef.current.scrollTo({
      left: newScroll,
      behavior: 'smooth',
    });
  }, []);

  React.useEffect(() => {
    const container = scrollContainerRef.current;
    if (container) {
      container.addEventListener('scroll', handleScroll);
      handleScroll();
      return () => container.removeEventListener('scroll', handleScroll);
    }
  }, [handleScroll, supportedUIResources.length]);

  if (supportedUIResources.length === 0) {
    return null;
  }

  if (supportedUIResources.length === 1) {
    return (
      <UIResourceRenderer
        resource={supportedUIResources[0]}
        onUIAction={async (result) => handleUIAction(result, ask)}
        htmlProps={{
          autoResizeIframe: { width: true, height: true },
        }}
      />
    );
  }

  return (
    <div
      className="relative mb-4 pt-3"
      onMouseEnter={() => setIsContainerHovered(true)}
      onMouseLeave={() => setIsContainerHovered(false)}
    >
      <div
        className={`from-surface-primary pointer-events-none absolute top-0 left-0 z-10 h-full w-24 bg-gradient-to-r to-transparent transition-opacity duration-500 ease-in-out ${
          showLeftArrow ? 'opacity-100' : 'opacity-0'
        }`}
      />

      <div
        className={`from-surface-primary pointer-events-none absolute top-0 right-0 z-10 h-full w-24 bg-gradient-to-l to-transparent transition-opacity duration-500 ease-in-out ${
          showRightArrow ? 'opacity-100' : 'opacity-0'
        }`}
      />

      {showLeftArrow && (
        <Button
          variant="carousel-nav"
          onClick={() => scroll('left')}
          className={cn(
            'absolute top-1/2 left-2 z-20 -translate-y-1/2 transition-all duration-200 hover:scale-110 active:scale-95',
            isContainerHovered ? 'opacity-100' : 'pointer-events-none opacity-0',
          )}
          aria-label={localize('com_ui_scroll_left')}
        >
          <ChevronLeft className="h-5 w-5" />
        </Button>
      )}

      <div
        ref={scrollContainerRef}
        className="hide-scrollbar flex gap-4 overflow-x-auto scroll-smooth"
      >
        {supportedUIResources.map((uiResource, index) => {
          const height = 360;
          const width = 230;

          return (
            <div
              key={index}
              className="animate-in fade-in-0 slide-in-from-bottom-5 shrink-0 transform-gpu transition-all duration-300 ease-out"
              style={{
                width: `${width}px`,
                minHeight: `${height}px`,
                animationDelay: `${index * 100}ms`,
              }}
            >
              <div className="flex h-full flex-col">
                <UIResourceRenderer
                  resource={uiResource}
                  onUIAction={async (result) => handleUIAction(result, ask)}
                  htmlProps={{
                    autoResizeIframe: { width: true, height: true },
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>

      {showRightArrow && (
        <Button
          variant="carousel-nav"
          onClick={() => scroll('right')}
          className={cn(
            'absolute top-1/2 right-2 z-20 -translate-y-1/2 transition-all duration-200 hover:scale-110 active:scale-95',
            isContainerHovered ? 'opacity-100' : 'pointer-events-none opacity-0',
          )}
          aria-label={localize('com_ui_scroll_right')}
        >
          <ChevronRight className="h-5 w-5" />
        </Button>
      )}
    </div>
  );
});

export default UIResourceCarousel;
