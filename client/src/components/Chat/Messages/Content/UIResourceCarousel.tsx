import React, { useState } from 'react';
import { Button } from '@librechat/client';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { UIResource } from 'librechat-data-provider';
import UIResourceRenderer, { isSupportedUIResource } from '~/components/MCPUIResource/Renderer';
import { useOptionalMessagesOperations } from '~/Providers';
import { handleUIAction } from '~/utils';
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
  const { ask } = useOptionalMessagesOperations();
  const supportedUIResources = React.useMemo(
    () => uiResources.filter(isSupportedUIResource),
    [uiResources],
  );

  const handleScroll = React.useCallback(() => {
    if (!scrollContainerRef.current) return;

    const { scrollLeft, scrollWidth, clientWidth } = scrollContainerRef.current;
    setShowLeftArrow(scrollLeft > 0);
    setShowRightArrow(scrollLeft < scrollWidth - clientWidth - 10);
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
          variant="ghost"
          size="icon"
          onClick={() => scroll('left')}
          className={`bg-surface-fixed text-text-fixed hover:bg-surface-fixed-hover hover:text-text-fixed absolute top-1/2 left-2 z-20 h-auto w-auto -translate-y-1/2 rounded-xl p-2 shadow-lg transition-all duration-200 hover:scale-110 hover:shadow-xl active:scale-95 ${
            isContainerHovered ? 'opacity-100' : 'pointer-events-none opacity-0'
          }`}
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
          variant="ghost"
          size="icon"
          onClick={() => scroll('right')}
          className={`bg-surface-fixed text-text-fixed hover:bg-surface-fixed-hover hover:text-text-fixed absolute top-1/2 right-2 z-20 h-auto w-auto -translate-y-1/2 rounded-xl p-2 shadow-lg transition-all duration-200 hover:scale-110 hover:shadow-xl active:scale-95 ${
            isContainerHovered ? 'opacity-100' : 'pointer-events-none opacity-0'
          }`}
          aria-label={localize('com_ui_scroll_right')}
        >
          <ChevronRight className="h-5 w-5" />
        </Button>
      )}
    </div>
  );
});

export default UIResourceCarousel;
