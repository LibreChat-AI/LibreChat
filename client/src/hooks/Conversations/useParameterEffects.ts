import { useEffect, useRef } from 'react';
import type { DynamicSettingProps, TPreset } from 'librechat-data-provider';
import { defaultDebouncedDelay } from '~/common';

function useParameterEffects<T = unknown>({
  preset,
  settingKey,
  defaultValue,
  conversation,
  inputValue,
  setInputValue,
  preventDelayedUpdate = false,
}: Pick<DynamicSettingProps, 'settingKey' | 'defaultValue' | 'conversation'> & {
  preset: TPreset | null;
  inputValue: T;
  setInputValue: (inputValue: T) => void;
  preventDelayedUpdate?: boolean;
}) {
  const idRef = useRef<string | null>(null);
  const presetIdRef = useRef<string | null>(null);

  /** Updates the local state inputValue if global (conversation) is updated elsewhere */
  useEffect(() => {
    if (preventDelayedUpdate) {
      return;
    }

    const timeout = setTimeout(() => {
      if (conversation?.[settingKey] === inputValue) {
        return;
      }
      setInputValue(conversation?.[settingKey]);
    }, defaultDebouncedDelay * 1.25);

    return () => clearTimeout(timeout);
  }, [setInputValue, preventDelayedUpdate, conversation, inputValue, settingKey]);

  /** Resets the local state if conversationId changed */
  useEffect(() => {
    const conversationId = conversation?.conversationId ?? '';
    if (!conversationId) {
      return;
    }

    if (idRef.current === conversationId) {
      return;
    }

    idRef.current = conversationId;
    /** Seed from what the conversation already holds, falling back to the
     *  definition default. Resetting to the default unconditionally made saved
     *  values read as defaults until the delayed sync below corrected them, and
     *  editing inside that window wrote the default back. */
    setInputValue((conversation?.[settingKey] ?? defaultValue) as T);
  }, [setInputValue, conversation, conversation?.conversationId, settingKey, defaultValue]);

  /** Resets the local state if presetId changed */
  useEffect(() => {
    const presetId = preset?.presetId ?? '';
    if (!presetId) {
      return;
    }

    if (presetIdRef.current === presetId) {
      return;
    }

    presetIdRef.current = presetId;
    setInputValue((preset?.[settingKey] ?? conversation?.[settingKey] ?? defaultValue) as T);
  }, [setInputValue, preset, preset?.presetId, conversation, settingKey, defaultValue]);
}

export default useParameterEffects;
