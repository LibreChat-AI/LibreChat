import { useState, useMemo, useEffect } from 'react';
import TextareaAutosize from 'react-textarea-autosize';
import { Label, HoverCard, SelectDropDown, HoverCardTrigger } from '@librechat/client';
import type { Assistant, TPreset } from 'librechat-data-provider';
import type { TModelSelectProps, Option } from '~/common';
import {
  cn,
  defaultTextProps,
  removeFocusRings,
  mapAssistants,
  createDropdownSetter,
} from '~/utils';
import { useLocalize, useDebouncedInput, useAssistantListMap } from '~/hooks';
import OptionHover from './OptionHover';
import { ESide } from '~/common';

export default function Settings({ conversation, setOption, models, readonly }: TModelSelectProps) {
  const localize = useLocalize();
  const defaultOption = useMemo(
    () => ({ label: localize('com_endpoint_use_active_assistant'), value: '' }),
    [localize],
  );

  const assistantListMap = useAssistantListMap((res) => mapAssistants(res.data));

  const { model, endpoint, assistant_id, endpointType, promptPrefix, instructions } =
    conversation ?? {};

  const currentList = useMemo(
    () => Object.values(assistantListMap[endpoint ?? ''] ?? {}) as Assistant[],
    [assistantListMap, endpoint],
  );

  const assistants = useMemo(() => {
    const currentAssistants = currentList.map(({ id, name }) => ({
      label: name,
      value: id,
    }));

    return [defaultOption, ...currentAssistants].filter(Boolean);
  }, [currentList, defaultOption]);

  const [onPromptPrefixChange, promptPrefixValue] = useDebouncedInput({
    setOption,
    optionKey: 'promptPrefix',
    initialValue: promptPrefix,
  });
  const [onInstructionsChange, instructionsValue] = useDebouncedInput({
    setOption,
    optionKey: 'instructions',
    initialValue: instructions,
  });

  const activeAssistant = useMemo(() => {
    if (assistant_id != null && assistant_id) {
      return assistantListMap[endpoint ?? '']?.[assistant_id] as Assistant | null;
    }

    return null;
  }, [assistant_id, assistantListMap, endpoint]);

  const modelOptions = useMemo(() => {
    return models.map((model) => ({
      label:
        model === activeAssistant?.model
          ? `${model} (${localize('com_endpoint_assistant_model')})`
          : model,
      value: model,
    }));
  }, [models, activeAssistant, localize]);

  const [assistantValue, setAssistantValue] = useState<Option>(
    activeAssistant != null
      ? { label: activeAssistant.name ?? '', value: activeAssistant.id }
      : defaultOption,
  );

  useEffect(() => {
    if (assistantValue.value === '') {
      setOption('presetOverride')({
        assistant_id: assistantValue.value,
      } as Partial<TPreset>);
    }

    // Reason: `setOption` causes a re-render on every update
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assistantValue]);

  if (!conversation) {
    return null;
  }

  const setModel = setOption('model');
  const setAssistant = (value: string) => {
    if (!value) {
      setAssistantValue(defaultOption);
      return;
    }

    const assistant = assistantListMap[endpoint ?? '']?.[value] as Assistant | null;
    if (!assistant) {
      setAssistantValue(defaultOption);
      return;
    }

    setAssistantValue({
      label: assistant.name ?? '',
      value: assistant.id || '',
    });
    setOption('assistant_id')(assistant.id);
    if (assistant.model) {
      setModel(assistant.model);
    }
  };

  const optionEndpoint = endpointType ?? endpoint;

  return (
    <div className="grid grid-cols-6 gap-6">
      <div className="col-span-6 flex flex-col items-center justify-start gap-6 sm:col-span-3">
        <div className="grid w-full items-center gap-2">
          <SelectDropDown
            value={model ?? ''}
            title={localize('com_ui_model')}
            setValue={createDropdownSetter(setModel)}
            availableValues={modelOptions}
            disabled={readonly}
            className={cn(defaultTextProps, 'flex w-full resize-none', removeFocusRings)}
            containerClassName="flex w-full resize-none"
          />
        </div>
      </div>
      <div className="col-span-6 flex flex-col items-center justify-start gap-6 px-3 sm:col-span-3">
        <HoverCard openDelay={300}>
          <HoverCardTrigger className="grid w-full items-center gap-2">
            <div className="grid w-full items-center gap-2">
              <SelectDropDown
                title={localize('com_endpoint_assistant')}
                value={assistantValue}
                setValue={createDropdownSetter(setAssistant)}
                availableValues={assistants as Option[]}
                disabled={readonly}
                className={cn(defaultTextProps, 'flex w-full resize-none', removeFocusRings)}
                containerClassName="flex w-full resize-none"
              />
            </div>
          </HoverCardTrigger>
          <OptionHover endpoint={optionEndpoint ?? ''} type="temp" side={ESide.Left} />
        </HoverCard>
      </div>
      <div className="col-span-6 flex flex-col items-center justify-start gap-6">
        <div className="grid w-full items-center gap-2">
          <Label htmlFor="promptPrefix" className="text-left text-sm font-medium">
            {localize('com_endpoint_prompt_prefix_assistants')}{' '}
            <small className="opacity-40 high-contrast:opacity-100">
              ({localize('com_endpoint_default_blank')})
            </small>
          </Label>
          <TextareaAutosize
            id="promptPrefix"
            disabled={readonly}
            value={(promptPrefixValue as string | null | undefined) ?? ''}
            onChange={onPromptPrefixChange}
            placeholder={localize('com_endpoint_prompt_prefix_assistants_placeholder')}
            className={cn(
              defaultTextProps,
              'flex max-h-[240px] min-h-[80px] w-full resize-none px-3 py-2',
            )}
          />
        </div>
        <div className="grid w-full items-center gap-2">
          <Label htmlFor="instructions" className="text-left text-sm font-medium">
            {localize('com_endpoint_instructions_assistants')}{' '}
            <small className="opacity-40 high-contrast:opacity-100">
              ({localize('com_endpoint_default_blank')})
            </small>
          </Label>
          <TextareaAutosize
            id="instructions"
            disabled={readonly}
            value={(instructionsValue as string | null | undefined) ?? ''}
            onChange={onInstructionsChange}
            placeholder={localize('com_endpoint_instructions_assistants_placeholder')}
            className={cn(
              defaultTextProps,
              'flex max-h-[240px] min-h-[80px] w-full resize-none px-3 py-2',
            )}
          />
        </div>
      </div>
    </div>
  );
}
