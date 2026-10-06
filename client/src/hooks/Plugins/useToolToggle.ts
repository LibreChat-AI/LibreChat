import { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import debounce from 'lodash/debounce';
import { useRecoilState } from 'recoil';
import { Constants, LocalStorageKeys } from 'librechat-data-provider';
import type { VerifyToolAuthResponse } from 'librechat-data-provider';
import type { UseQueryOptions } from '@tanstack/react-query';
import { useVerifyAgentToolAuth, useGetStartupConfig } from '~/data-provider';
import useLocalStorage from '~/hooks/useLocalStorageAlt';
import { setTimestamp } from '~/utils/timestamps';
import { ephemeralAgentByConvoId } from '~/store';

type ToolValue = boolean | string;

interface UseToolToggleOptions {
  conversationId?: string | null;
  storageContextKey?: string;
  toolKey: string;
  localStorageKey: LocalStorageKeys;
  isAuthenticated?: boolean;
  setIsDialogOpen?: (open: boolean) => void;
  /** Options for auth verification */
  authConfig?: {
    toolId: string;
    queryOptions?: UseQueryOptions<VerifyToolAuthResponse>;
  };
}

export function useToolToggle({
  conversationId,
  storageContextKey,
  toolKey: _toolKey,
  localStorageKey,
  isAuthenticated: externalIsAuthenticated,
  setIsDialogOpen,
  authConfig,
}: UseToolToggleOptions) {
  const key = conversationId ?? Constants.NEW_CONVO;
  const [ephemeralAgent, setEphemeralAgent] = useRecoilState(ephemeralAgentByConvoId(key));
  const { data: startupConfig } = useGetStartupConfig();

  const authQuery = useVerifyAgentToolAuth(
    { toolId: authConfig?.toolId || '' },
    {
      enabled: !!authConfig?.toolId,
      ...authConfig?.queryOptions,
    },
  );

  const isAuthenticated = useMemo(
    () =>
      externalIsAuthenticated ?? (authConfig ? (authQuery?.data?.authenticated ?? false) : false),
    [externalIsAuthenticated, authConfig, authQuery.data?.authenticated],
  );

  const toolKey = useMemo(() => _toolKey, [_toolKey]);
  const storageKey = useMemo(() => `${localStorageKey}${key}`, [localStorageKey, key]);

  // The actual current value comes from ephemeralAgent
  const toolValue = useMemo(() => {
    return ephemeralAgent?.[toolKey] ?? false;
  }, [ephemeralAgent, toolKey]);

  const isToolEnabled = useMemo(() => {
    // For backward compatibility, treat truthy string values as enabled
    if (typeof toolValue === 'string') {
      return toolValue.length > 0;
    }
    return toolValue === true;
  }, [toolValue]);

  // Sync to localStorage with timestamps when ephemeralAgent changes
  useEffect(() => {
    const value = ephemeralAgent?.[toolKey];
    if (value !== undefined) {
      localStorage.setItem(storageKey, JSON.stringify(value));
      setTimestamp(storageKey);
    }
  }, [ephemeralAgent, toolKey, storageKey]);

  /** Admin-configured default: pin this tool when its key is listed in `defaultPinnedTools`.
   *  Only seeds the initial state — a user's stored pin preference always takes precedence. */
  const defaultPinned = useMemo(() => {
    const defaultPinnedTools = startupConfig?.interface?.defaultPinnedTools;
    return Array.isArray(defaultPinnedTools) && defaultPinnedTools.includes(toolKey);
  }, [startupConfig?.interface?.defaultPinnedTools, toolKey]);

  /** Captured before mount (pre-seed): did the user already have a stored pin preference?
   *  Distinguishes a real choice from `useLocalStorage`'s eager default-seed below. Legacy
   *  auto-seeded values count as a preference, so existing users keep their state. */
  const [hadStoredPin] = useState(() => localStorage.getItem(`${localStorageKey}pinned`) != null);

  const [isPinned, setIsPinnedRaw] = useLocalStorage<boolean>(
    `${localStorageKey}pinned`,
    defaultPinned,
  );

  /** Mark explicit pin toggles so a click made before `startupConfig` resolves is never
   *  clobbered by the admin-default effect below. */
  const userSetPin = useRef(false);
  const setIsPinned = useCallback(
    (value: boolean) => {
      userSetPin.current = true;
      setIsPinnedRaw(value);
    },
    [setIsPinnedRaw],
  );

  /** Cold load: `startupConfig` can resolve after mount, so `defaultPinned` starts `false`
   *  and gets eagerly persisted. Once config arrives, apply the real default for users who
   *  have neither a stored preference nor an in-session pin click — runs once. */
  const appliedDefaultPin = useRef(false);
  useEffect(() => {
    if (appliedDefaultPin.current || startupConfig == null) {
      return;
    }
    appliedDefaultPin.current = true;
    if (hadStoredPin || userSetPin.current) {
      return;
    }
    if (defaultPinned !== isPinned) {
      setIsPinnedRaw(defaultPinned);
    }
  }, [startupConfig, hadStoredPin, defaultPinned, isPinned, setIsPinnedRaw]);

  const handleChange = useCallback(
    ({ e, value }: { e?: React.ChangeEvent<HTMLInputElement>; value: ToolValue }) => {
      if (isAuthenticated !== undefined && !isAuthenticated && setIsDialogOpen) {
        setIsDialogOpen(true);
        e?.preventDefault?.();
        setEphemeralAgent((prev) => ({
          ...(prev || {}),
          [toolKey]: false,
        }));
        return;
      }

      // Update ephemeralAgent (localStorage will sync automatically via effect)
      setEphemeralAgent((prev) => ({
        ...(prev || {}),
        [toolKey]: value,
      }));

      // Dual-write to environment key for new conversation defaults
      if (storageContextKey) {
        const envKey = `${localStorageKey}${storageContextKey}`;
        localStorage.setItem(envKey, JSON.stringify(value));
        setTimestamp(envKey);
      }
    },
    [
      setIsDialogOpen,
      isAuthenticated,
      setEphemeralAgent,
      toolKey,
      storageContextKey,
      localStorageKey,
    ],
  );

  const debouncedChange = useMemo(
    () => debounce(handleChange, 50, { leading: true }),
    [handleChange],
  );

  const setToggleState = useCallback((value: ToolValue) => handleChange({ value }), [handleChange]);

  /* Memoized because `BadgeRowContext` puts six of these in a context value that
     the composer palette derives its whole catalog from: a fresh object here on
     every render made that value change on every keystroke, whatever the
     provider did about it. */
  return useMemo(
    () => ({
      toggleState: toolValue, // Return the actual value from ephemeralAgent
      handleChange,
      isToolEnabled,
      toolValue,
      setToggleState, // Adapter for direct setting
      ephemeralAgent,
      debouncedChange,
      setEphemeralAgent,
      authData: authQuery?.data,
      isPinned,
      setIsPinned,
    }),
    [
      toolValue,
      handleChange,
      isToolEnabled,
      setToggleState,
      ephemeralAgent,
      debouncedChange,
      setEphemeralAgent,
      authQuery?.data,
      isPinned,
      setIsPinned,
    ],
  );
}
