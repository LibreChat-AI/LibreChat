import TextareaAutosize from 'react-textarea-autosize';
import { ImageDetail, imageDetailNumeric, imageDetailValue } from 'librechat-data-provider';
import {
  Input,
  Label,
  Switch,
  Slider,
  HoverCard,
  InputNumber,
  HoverCardTrigger,
} from '@librechat/client';
import type { ValueType } from '@rc-component/mini-decimal';
import type { TModelSelectProps } from '~/common';
import { cn, defaultTextProps, optionText, removeFocusOutlines } from '~/utils';
import { useLocalize, useDebouncedInput } from '~/hooks';
import OptionHover from './OptionHover';
import { ESide } from '~/common';

export default function Settings({
  conversation,
  setOption,
  readonly,
}: Omit<TModelSelectProps, 'models'>) {
  /* This is an unfinished component for future update */
  const localize = useLocalize();
  const {
    endpoint,
    endpointType,
    chatGptLabel,
    promptPrefix,
    temperature,
    top_p: topP,
    frequency_penalty: freqP,
    presence_penalty: presP,
    resendFiles,
    imageDetail,
  } = conversation ?? {};
  const [setChatGptLabel, chatGptLabelValue] = useDebouncedInput({
    setOption,
    optionKey: 'chatGptLabel',
    initialValue: chatGptLabel,
  });
  const [setPromptPrefix, promptPrefixValue] = useDebouncedInput({
    setOption,
    optionKey: 'promptPrefix',
    initialValue: promptPrefix,
  });
  const [setTemperature, temperatureValue] = useDebouncedInput({
    setOption,
    optionKey: 'temperature',
    initialValue: temperature,
  });
  const [setTopP, topPValue] = useDebouncedInput({
    setOption,
    optionKey: 'top_p',
    initialValue: topP,
  });
  const [setFreqP, freqPValue] = useDebouncedInput({
    setOption,
    optionKey: 'frequency_penalty',
    initialValue: freqP,
  });
  const [setPresP, presPValue] = useDebouncedInput({
    setOption,
    optionKey: 'presence_penalty',
    initialValue: presP,
  });

  if (!conversation) {
    return null;
  }

  const setResendFiles = setOption('resendFiles');
  const setImageDetail = setOption('imageDetail');

  const optionEndpoint = endpointType ?? endpoint;

  return (
    <div className="grid grid-cols-5 gap-6">
      <div className="col-span-5 flex flex-col items-center justify-start gap-6 sm:col-span-3">
        <div className="grid w-full items-center gap-2">
          <Label htmlFor="chatGptLabel" className="text-left text-sm font-medium">
            {localize('com_endpoint_custom_name')}{' '}
            <small className="opacity-40 high-contrast:opacity-100">
              ({localize('com_endpoint_default_blank')})
            </small>
          </Label>
          <Input
            id="chatGptLabel"
            disabled={readonly}
            value={(chatGptLabelValue as string) || ''}
            onChange={setChatGptLabel}
            placeholder={localize('com_endpoint_openai_custom_name_placeholder')}
            className={cn(
              defaultTextProps,
              'flex h-10 max-h-10 w-full resize-none px-3 py-2',
              removeFocusOutlines,
            )}
          />
        </div>
        <div className="grid w-full items-center gap-2">
          <Label htmlFor="promptPrefix" className="text-left text-sm font-medium">
            {localize('com_endpoint_prompt_prefix')}{' '}
            <small className="opacity-40 high-contrast:opacity-100">
              ({localize('com_endpoint_default_blank')})
            </small>
          </Label>
          <TextareaAutosize
            id="promptPrefix"
            disabled={readonly}
            value={(promptPrefixValue as string) || ''}
            onChange={setPromptPrefix}
            placeholder={localize('com_endpoint_openai_prompt_prefix_placeholder')}
            className={cn(
              defaultTextProps,
              'flex max-h-[138px] min-h-[100px] w-full resize-none px-3 py-2',
            )}
          />
        </div>
      </div>
      <div className="col-span-5 flex flex-col items-center justify-start gap-6 px-3 sm:col-span-2">
        <HoverCard openDelay={300}>
          <HoverCardTrigger className="grid w-full items-center gap-2">
            <div className="flex justify-between">
              <Label htmlFor="temp-int" className="text-left text-sm font-medium">
                {localize('com_endpoint_temperature')}{' '}
                <small className="opacity-40 high-contrast:opacity-100">
                  ({localize('com_endpoint_default_with_num', { 0: '1' })})
                </small>
              </Label>
              <InputNumber
                id="temp-int"
                disabled={readonly}
                value={temperatureValue as number}
                onChange={setTemperature as (value: ValueType | null) => void}
                max={2}
                min={0}
                step={0.01}
                controls={false}
                className={cn(
                  defaultTextProps,
                  cn(
                    optionText,
                    'reset-rc-number-input reset-rc-number-input-text-right h-auto w-12 border-0 group-hover/temp:border-border-light',
                  ),
                )}
              />
            </div>
            <Slider
              disabled={readonly}
              value={[(temperatureValue as number) ?? 1]}
              onValueChange={(value) => setTemperature(value[0])}
              onDoubleClick={() => setTemperature(1)}
              max={2}
              min={0}
              step={0.01}
              className="flex h-4 w-full"
              aria-labelledby="temp-int"
            />
          </HoverCardTrigger>
          <OptionHover endpoint={optionEndpoint ?? ''} type="temp" side={ESide.Left} />
        </HoverCard>
        <HoverCard openDelay={300}>
          <HoverCardTrigger className="grid w-full items-center gap-2">
            <div className="flex justify-between">
              <Label htmlFor="top-p-int" className="text-left text-sm font-medium">
                {localize('com_endpoint_top_p')}{' '}
                <small className="opacity-40 high-contrast:opacity-100">
                  ({localize('com_endpoint_default_with_num', { 0: '1' })})
                </small>
              </Label>
              <InputNumber
                id="top-p-int"
                disabled={readonly}
                value={topPValue as number}
                onChange={(value) => setTopP(Number(value))}
                max={1}
                min={0}
                step={0.01}
                controls={false}
                className={cn(
                  defaultTextProps,
                  cn(
                    optionText,
                    'reset-rc-number-input reset-rc-number-input-text-right h-auto w-12 border-0 group-hover/temp:border-border-light',
                  ),
                )}
              />
            </div>
            <Slider
              disabled={readonly}
              value={[(topPValue as number) ?? 1]}
              onValueChange={(value) => setTopP(value[0])}
              onDoubleClick={() => setTopP(1)}
              max={1}
              min={0}
              step={0.01}
              className="flex h-4 w-full"
              aria-labelledby="top-p-int"
            />
          </HoverCardTrigger>
          <OptionHover endpoint={optionEndpoint ?? ''} type="topp" side={ESide.Left} />
        </HoverCard>

        <HoverCard openDelay={300}>
          <HoverCardTrigger className="grid w-full items-center gap-2">
            <div className="flex justify-between">
              <Label htmlFor="freq-penalty-int" className="text-left text-sm font-medium">
                {localize('com_endpoint_frequency_penalty')}{' '}
                <small className="opacity-40 high-contrast:opacity-100">
                  ({localize('com_endpoint_default_with_num', { 0: '0' })})
                </small>
              </Label>
              <InputNumber
                id="freq-penalty-int"
                disabled={readonly}
                value={freqPValue as number}
                onChange={(value) => setFreqP(Number(value))}
                max={2}
                min={-2}
                step={0.01}
                controls={false}
                className={cn(
                  defaultTextProps,
                  cn(
                    optionText,
                    'reset-rc-number-input reset-rc-number-input-text-right h-auto w-12 border-0 group-hover/temp:border-border-light',
                  ),
                )}
              />
            </div>
            <Slider
              disabled={readonly}
              value={[(freqPValue as number) ?? 0]}
              onValueChange={(value) => setFreqP(value[0])}
              onDoubleClick={() => setFreqP(0)}
              max={2}
              min={-2}
              step={0.01}
              className="flex h-4 w-full"
              aria-labelledby="freq-penalty-int"
            />
          </HoverCardTrigger>
          <OptionHover endpoint={optionEndpoint ?? ''} type="freq" side={ESide.Left} />
        </HoverCard>

        <HoverCard openDelay={300}>
          <HoverCardTrigger className="grid w-full items-center gap-2">
            <div className="flex justify-between">
              <Label htmlFor="pres-penalty-int" className="text-left text-sm font-medium">
                {localize('com_endpoint_presence_penalty')}{' '}
                <small className="opacity-40 high-contrast:opacity-100">
                  ({localize('com_endpoint_default_with_num', { 0: '0' })})
                </small>
              </Label>
              <InputNumber
                id="pres-penalty-int"
                disabled={readonly}
                value={presPValue as number}
                onChange={(value) => setPresP(Number(value))}
                max={2}
                min={-2}
                step={0.01}
                controls={false}
                className={cn(
                  defaultTextProps,
                  cn(
                    optionText,
                    'reset-rc-number-input reset-rc-number-input-text-right h-auto w-12 border-0 group-hover/temp:border-border-light',
                  ),
                )}
              />
            </div>
            <Slider
              disabled={readonly}
              value={[(presPValue as number) ?? 0]}
              onValueChange={(value) => setPresP(value[0])}
              onDoubleClick={() => setPresP(0)}
              max={2}
              min={-2}
              step={0.01}
              className="flex h-4 w-full"
              aria-labelledby="pres-penalty-int"
            />
          </HoverCardTrigger>
          <OptionHover endpoint={optionEndpoint ?? ''} type="pres" side={ESide.Left} />
        </HoverCard>
        <div className="w-full">
          <div className="mb-2 flex w-full justify-between gap-2">
            <Label
              htmlFor="resend-files"
              className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
            >
              <small>{localize('com_endpoint_plug_resend_files')}</small>
            </Label>
            <Label
              htmlFor="image-detail-value"
              className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
            >
              <small>{localize('com_endpoint_plug_image_detail')}</small>
            </Label>
            <Input
              id="image-detail-value"
              disabled={true}
              value={imageDetail ?? ImageDetail.auto}
              className={cn(
                defaultTextProps,
                optionText,
                'flex rounded-md border-border-light bg-transparent py-2 text-xs focus:outline-none focus:ring-2 focus:ring-ring-primary focus:ring-offset-2',
                'pointer-events-none max-h-5 w-12 border-0 group-hover/temp:border-border-light',
              )}
            />
          </div>
          <div className="flex w-full justify-between gap-2">
            <HoverCard openDelay={500}>
              <HoverCardTrigger>
                <Switch
                  id="resend-files"
                  checked={resendFiles ?? true}
                  onCheckedChange={(checked: boolean) => setResendFiles(checked)}
                  disabled={readonly}
                  className="flex"
                  aria-label={localize('com_endpoint_plug_resend_files')}
                />
                <OptionHover endpoint={optionEndpoint ?? ''} type="resend" side={ESide.Bottom} />
              </HoverCardTrigger>
            </HoverCard>
            <HoverCard openDelay={500}>
              <HoverCardTrigger className="flex w-[52%] md:w-[125px]">
                <Slider
                  id="image-detail-slider"
                  disabled={readonly}
                  value={[
                    imageDetailNumeric[imageDetail ?? ''] ?? imageDetailNumeric[ImageDetail.auto],
                  ]}
                  onValueChange={(value) => setImageDetail(imageDetailValue[value[0]])}
                  onDoubleClick={() => setImageDetail(ImageDetail.auto)}
                  max={2}
                  min={0}
                  step={1}
                  aria-label={localize('com_endpoint_plug_image_detail')}
                />
                <OptionHover endpoint={optionEndpoint ?? ''} type="detail" side={ESide.Bottom} />
              </HoverCardTrigger>
            </HoverCard>
          </div>
        </div>
      </div>
    </div>
  );
}
