import { useCallback, useRef, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { QueryKeys, Time, dataService } from 'librechat-data-provider';
import { logger } from '~/utils';

export const useHealthCheck = (isAuthenticated = false) => {
  const queryClient = useQueryClient();
  const isInitialized = useRef(false);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const focusHandlerRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    // Only start health check if authenticated
    if (!isAuthenticated) {
      return;
    }

    // Prevent multiple initializations
    if (isInitialized.current) {
      return;
    }
    isInitialized.current = true;

    // Use a longer delay to ensure all rendering is complete
    const initTimer = setTimeout(() => {
      const performHealthCheck = async () => {
        try {
          await queryClient.fetchQuery([QueryKeys.health], () => dataService.healthCheck(), {
            retry: false,
            cacheTime: 0,
            staleTime: 0,
          });
        } catch (error) {
          console.error('Health check failed:', error);
        }
      };

      // Initial check
      performHealthCheck();

      // Set up interval for recurring checks
      intervalRef.current = setInterval(performHealthCheck, Time.TEN_MINUTES);

      // Set up window focus handler
      const handleWindowFocus = async () => {
        const queryState = queryClient.getQueryState([QueryKeys.health]);

        if (!queryState?.dataUpdatedAt) {
          await performHealthCheck();
          return;
        }

        const lastUpdated = new Date(queryState.dataUpdatedAt);
        const tenMinutesAgo = new Date(Date.now() - Time.TEN_MINUTES);

        logger.log(`Last health check: ${lastUpdated.toISOString()}`);
        logger.log(`Ten minutes ago: ${tenMinutesAgo.toISOString()}`);

        if (lastUpdated < tenMinutesAgo) {
          await performHealthCheck();
        }
      };

      // Store handler for cleanup
      focusHandlerRef.current = handleWindowFocus;
      window.addEventListener('focus', handleWindowFocus);
    }, 500);

    return () => {
      isInitialized.current = false;
      clearTimeout(initTimer);
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      // Remove focus event listener if it was added
      if (focusHandlerRef.current) {
        window.removeEventListener('focus', focusHandlerRef.current);
        focusHandlerRef.current = null;
      }
    };
  }, [isAuthenticated, queryClient]);
};

export const useInteractionHealthCheck = () => {
  const queryClient = useQueryClient();
  const lastInteractionTimeRef = useRef(Date.now());

  const checkHealthOnInteraction = useCallback(() => {
    const currentTime = Date.now();
    if (currentTime - lastInteractionTimeRef.current > Time.FIVE_MINUTES) {
      logger.log(
        'Checking health on interaction. Time elapsed:',
        currentTime - lastInteractionTimeRef.current,
      );
      queryClient.invalidateQueries([QueryKeys.health]);
      lastInteractionTimeRef.current = currentTime;
    }
  }, [queryClient]);

  return checkHealthOnInteraction;
};
