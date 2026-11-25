import React, { useState, useEffect } from 'react';

interface SmartLoaderProps {
  /** Whether the content is currently loading */
  isLoading: boolean;
  /** Whether there is existing data to show */
  hasData: boolean;
  /** Delay before showing loading state (in ms) - prevents flashing for quick loads */
  delay?: number;
  /** Loading skeleton/spinner component */
  loadingComponent: React.ReactNode;
  /** Content to show when loaded */
  children: React.ReactNode;
  /** Additional CSS classes */
  className?: string;
}

/**
 * SmartLoader - Intelligent loading wrapper that prevents flashing
 *
 * Only shows loading states when:
 * 1. Actually loading AND no existing data
 * 2. Loading has lasted longer than the delay threshold
 *
 * This prevents brief loading flashes for cached/fast responses
 */
export const SmartLoader: React.FC<SmartLoaderProps> = ({
  isLoading,
  hasData,
  delay = 150,
  loadingComponent,
  children,
  className = '',
}) => {
  const [shouldShowLoading, setShouldShowLoading] = useState(false);

  useEffect(() => {
    let timeoutId: NodeJS.Timeout;

    if (isLoading && !hasData) {
      // Only show loading after delay to prevent flashing
      timeoutId = setTimeout(() => {
        setShouldShowLoading(true);
      }, delay);
    } else {
      // Immediately hide loading when done
      setShouldShowLoading(false);
    }

    return () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }, [isLoading, hasData, delay]);

  // Show loading state only if we've determined it should be shown
  if (shouldShowLoading) {
    return <div className={className}>{loadingComponent}</div>;
  }

  // Show content (including when loading but we have existing data)
  return <div className={className}>{children}</div>;
};

export default SmartLoader;
