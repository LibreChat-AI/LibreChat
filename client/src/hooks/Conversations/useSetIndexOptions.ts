import {
  TPreset,
  TConversation,
  EModelEndpoint,
  tConvoUpdateSchema,
} from 'librechat-data-provider';
import type { TSetExample, TSetOption, TSetOptionsPayload } from '~/common';
import usePresetIndexOptions from './usePresetIndexOptions';
import { useChatContext } from '~/Providers/ChatContext';

type TUseSetOptions = (preset?: TPreset | boolean | null) => TSetOptionsPayload;

const useSetIndexOptions: TUseSetOptions = (preset = false) => {
  const { conversation, setConversation } = useChatContext();

  const result = usePresetIndexOptions(preset);

  if (result && typeof result !== 'boolean') {
    return result;
  }

  const setOption: TSetOption = (param) => (newValue) => {
    const update = {};
    update[param] = newValue;

    if (param === 'presetOverride') {
      const currentOverride = conversation?.presetOverride || {};
      update['presetOverride'] = {
        ...currentOverride,
        ...(newValue as unknown as Partial<TPreset>),
      };
    }

    // Auto-enable Responses API when web search is enabled (only for OpenAI/Azure/Custom endpoints)
    if (param === 'web_search' && newValue === true) {
      const currentEndpoint = conversation?.endpoint;
      const isOpenAICompatible =
        currentEndpoint === EModelEndpoint.openAI ||
        currentEndpoint === EModelEndpoint.azureOpenAI ||
        currentEndpoint === EModelEndpoint.custom;

      if (isOpenAICompatible) {
        const currentUseResponsesApi = conversation?.useResponsesApi ?? false;
        if (!currentUseResponsesApi) {
          update['useResponsesApi'] = true;
        }
      }
    }

    setConversation((prevState) => {
      if (prevState && Object.keys(update).every((key) => Object.is(prevState[key], update[key]))) {
        return prevState;
      }
      return tConvoUpdateSchema.parse({
        ...prevState,
        ...update,
      }) as TConversation;
    });
  };

  const setExample: TSetExample = (i, type, newValue = null) => {
    const update = {};
    const current = conversation?.examples?.slice() || [];
    const currentExample = { ...current[i] };
    currentExample[type] = { content: newValue };
    current[i] = currentExample;
    update['examples'] = current;
    setConversation(
      (prevState) =>
        tConvoUpdateSchema.parse({
          ...prevState,
          ...update,
        }) as TConversation,
    );
  };

  const addExample: () => void = () => {
    const update = {};
    const current = conversation?.examples?.slice() || [];
    current.push({ input: { content: '' }, output: { content: '' } });
    update['examples'] = current;
    setConversation(
      (prevState) =>
        tConvoUpdateSchema.parse({
          ...prevState,
          ...update,
        }) as TConversation,
    );
  };

  const removeExample: () => void = () => {
    const update = {};
    const current = conversation?.examples?.slice() || [];
    if (current.length <= 1) {
      update['examples'] = [{ input: { content: '' }, output: { content: '' } }];
      setConversation(
        (prevState) =>
          tConvoUpdateSchema.parse({
            ...prevState,
            ...update,
          }) as TConversation,
      );
      return;
    }
    current.pop();
    update['examples'] = current;
    setConversation(
      (prevState) =>
        tConvoUpdateSchema.parse({
          ...prevState,
          ...update,
        }) as TConversation,
    );
  };

  return {
    setOption,
    setExample,
    addExample,
    removeExample,
  };
};

export default useSetIndexOptions;
