import type { TPreset } from 'librechat-data-provider';
import type { TSetOptionsPayload, TSetExample, TSetOption, TSetOptions } from '~/common';
import { useChatContext } from '~/Providers/ChatContext';
import { cleanupPreset } from '~/utils';

type TUsePresetOptions = (preset?: TPreset | boolean | null) => TSetOptionsPayload | boolean;

const usePresetIndexOptions: TUsePresetOptions = (_preset) => {
  const { preset, setPreset } = useChatContext();

  if (!_preset) {
    return false;
  }
  const getConversation: () => TPreset | null = () => preset;

  const setOptions: TSetOptions = (options) => {
    const update = { ...options };
    setPreset((prevState) =>
      cleanupPreset({
        preset: {
          ...prevState,
          ...update,
        },
      }),
    );
  };

  const setOption: TSetOption = (param) => (newValue) => {
    const update = {};
    update[param] = newValue;
    setPreset((prevState) =>
      cleanupPreset({
        preset: {
          ...prevState,
          ...update,
        },
      }),
    );
  };

  const setExample: TSetExample = (i, type, newValue = null) => {
    const update = {};
    const current = preset?.examples?.slice() || [];
    const currentExample = { ...current[i] };
    currentExample[type] = { content: newValue };
    current[i] = currentExample;
    update['examples'] = current;
    setPreset((prevState) =>
      cleanupPreset({
        preset: {
          ...prevState,
          ...update,
        },
      }),
    );
  };

  const addExample: () => void = () => {
    const update = {};
    const current = preset?.examples?.slice() || [];
    current.push({ input: { content: '' }, output: { content: '' } });
    update['examples'] = current;
    setPreset((prevState) =>
      cleanupPreset({
        preset: {
          ...prevState,
          ...update,
        },
      }),
    );
  };

  const removeExample: () => void = () => {
    const update = {};
    const current = preset?.examples?.slice() || [];
    if (current.length <= 1) {
      update['examples'] = [{ input: { content: '' }, output: { content: '' } }];
      setPreset((prevState) =>
        cleanupPreset({
          preset: {
            ...prevState,
            ...update,
          },
        }),
      );
      return;
    }
    current.pop();
    update['examples'] = current;
    setPreset((prevState) =>
      cleanupPreset({
        preset: {
          ...prevState,
          ...update,
        },
      }),
    );
  };

  return {
    setOption,
    setExample,
    addExample,
    setOptions,
    removeExample,
    getConversation,
  };
};

export default usePresetIndexOptions;
