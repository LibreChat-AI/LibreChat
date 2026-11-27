import { useCallback, useEffect, useRef } from 'react';
import { useRecoilValue } from 'recoil';
import { mergeFileConfig } from 'librechat-data-provider';
import type { FileConfig } from 'librechat-data-provider';
import type { ResizeOptions, ResizeResult } from '~/utils/imageResize';
import { resizeImage, shouldResizeImage, supportsClientResize } from '~/utils/imageResize';
import { useGetFileConfig } from '~/data-provider';
import store from '~/store';

type ClientImageResizeConfig = NonNullable<FileConfig['clientImageResize']>;
const FILE_CONFIG_WAIT_TIMEOUT_MS = 10_000;

const defaultConfig: ClientImageResizeConfig = {
  enabled: false,
  maxWidth: 1900,
  maxHeight: 1900,
  quality: 0.92,
  enforced: false,
};

/**
 * Hook for client-side image resizing functionality
 *
 * Resolution order is admin config, then user setting, then off: when
 * `clientImageResize.enabled` is set in `librechat.yaml` it is reported as
 * `enforced` and the user's setting is ignored.
 */
export const useClientResize = () => {
  const userPreference = useRecoilValue(store.clientImageResize);
  const {
    data: fileConfig = null,
    isError: isFileConfigError,
    isPaused: isFileConfigPaused,
    isSuccess: isFileConfigLoaded,
  } = useGetFileConfig({
    select: (data) => mergeFileConfig(data),
  });

  const config = fileConfig?.clientImageResize ?? defaultConfig;
  const { maxWidth, maxHeight, quality } = config;
  const isSupported = supportsClientResize();
  const isEnforced = config.enforced === true;
  const isConfigPending = !isFileConfigLoaded && !isFileConfigError && !isFileConfigPaused;
  const isConfigUnavailable = !isFileConfigLoaded && !isConfigPending;
  const hasValidDimensions =
    typeof maxWidth === 'number' &&
    Number.isFinite(maxWidth) &&
    maxWidth > 0 &&
    typeof maxHeight === 'number' &&
    Number.isFinite(maxHeight) &&
    maxHeight > 0;
  const isEnabled =
    isFileConfigLoaded &&
    hasValidDimensions &&
    (isEnforced ? config.enabled === true : userPreference);
  const isConfigPendingRef = useRef(isConfigPending);
  const configWaitTimedOutRef = useRef(false);
  const configWaitersRef = useRef(new Set<() => void>());
  const resizeStateRef = useRef({ isEnabled, isSupported, maxWidth, maxHeight, quality });

  isConfigPendingRef.current = isConfigPending;
  if (!isConfigPending) {
    configWaitTimedOutRef.current = false;
  }
  resizeStateRef.current = { isEnabled, isSupported, maxWidth, maxHeight, quality };

  const waitForConfig = useCallback((): Promise<void> => {
    if (!isConfigPendingRef.current || configWaitTimedOutRef.current) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const finishWaiting = () => {
        clearTimeout(timeoutId);
        configWaitersRef.current.delete(finishWaiting);
        resolve();
      };
      const timeoutId = setTimeout(() => {
        configWaitTimedOutRef.current = true;
        finishWaiting();
      }, FILE_CONFIG_WAIT_TIMEOUT_MS);
      configWaitersRef.current.add(finishWaiting);
    });
  }, []);

  useEffect(() => {
    if (isConfigPending) {
      return;
    }

    for (const resolve of configWaitersRef.current) {
      resolve();
    }
    configWaitersRef.current.clear();
  }, [isConfigPending]);

  useEffect(
    () => () => {
      for (const resolve of configWaitersRef.current) {
        resolve();
      }
      configWaitersRef.current.clear();
    },
    [],
  );

  /**
   * Resizes an image if client-side resizing is enabled and supported
   * @param file - The image file to resize
   * @param options - Optional resize options to override defaults
   * @returns Promise resolving to either the resized file result or original file
   */
  const resizeImageIfNeeded = useCallback(
    async (
      file: File,
      options?: Partial<ResizeOptions>,
    ): Promise<{ file: File; resized: boolean; result?: ResizeResult }> => {
      await waitForConfig();

      const {
        isEnabled: isResizeEnabled,
        isSupported: isResizeSupported,
        maxWidth: currentMaxWidth,
        maxHeight: currentMaxHeight,
        quality: currentQuality,
      } = resizeStateRef.current;

      // Return original file if resizing is disabled
      if (!isResizeEnabled) {
        return { file, resized: false };
      }

      // Return original file if browser doesn't support resizing
      if (!isResizeSupported) {
        console.warn('Client-side image resizing not supported in this browser');
        return { file, resized: false };
      }

      // Return original file if it doesn't need resizing
      if (!shouldResizeImage(file)) {
        return { file, resized: false };
      }

      try {
        const resizeOptions: Partial<ResizeOptions> = {
          maxWidth: currentMaxWidth,
          maxHeight: currentMaxHeight,
          quality: currentQuality,
          ...options,
        };

        const result = await resizeImage(file, resizeOptions);
        return { file: result.file, resized: result.file !== file, result };
      } catch (error) {
        console.warn('Client-side image resizing failed:', error);
        return { file, resized: false };
      }
    },
    [waitForConfig],
  );

  return {
    isEnabled,
    isEnforced,
    isSupported,
    isConfigPending,
    isConfigUnavailable,
    config,
    waitForConfig,
    resizeImageIfNeeded,
  };
};

export default useClientResize;
