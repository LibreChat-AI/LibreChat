import { useRecoilState } from 'recoil';
import { EModelEndpoint, SettingsViews } from 'librechat-data-provider';
import { Button, MessagesSquared, AssistantIcon, DataIcon } from '@librechat/client';
import type { ReactNode } from 'react';
import { useChatContext } from '~/Providers';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';
import store from '~/store';

type TPopoverButton = {
  label: string;
  buttonClass: string;
  handler: () => void;
  type?: 'alternative';
  icon: ReactNode;
};

export default function PopoverButtons({
  buttonClass,
  iconClass = '',
  endpoint: _overrideEndpoint,
  endpointType: overrideEndpointType,
  model: overrideModel,
}: {
  buttonClass?: string;
  iconClass?: string;
  endpoint?: EModelEndpoint | string;
  endpointType?: EModelEndpoint | string | null;
  model?: string | null;
}) {
  const localize = useLocalize();
  const { conversation, optionSettings, setOptionSettings } = useChatContext();
  const [settingsView, setSettingsView] = useRecoilState(store.currentSettingsView);

  const { model: _model, endpoint: _endpoint, endpointType } = conversation ?? {};
  const overrideEndpoint = overrideEndpointType ?? _overrideEndpoint;
  const endpoint = overrideEndpoint ?? endpointType ?? _endpoint ?? '';
  const model = overrideModel ?? _model;

  const isGenerativeModel = /gemini|learnlm|gemma/.test(model ?? '') ?? false;
  const isChatModel = (!isGenerativeModel && model?.toLowerCase().includes('chat')) ?? false;
  const isTextModel = !isGenerativeModel && !isChatModel && /code|text/.test(model ?? '');

  const { showExamples } = optionSettings;
  const showExamplesButton = !isGenerativeModel && !isTextModel && isChatModel;

  const triggerExamples = () => {
    setSettingsView(SettingsViews.default);
    setOptionSettings((prev) => ({ ...prev, showExamples: !(prev.showExamples ?? false) }));
  };

  const endpointSpecificbuttons: { [key: string]: TPopoverButton[] } = {
    [EModelEndpoint.google]: [
      {
        label: localize(showExamples === true ? 'com_hide_examples' : 'com_show_examples'),
        buttonClass: isGenerativeModel === true || isTextModel ? 'disabled' : '',
        handler: triggerExamples,
        icon: <MessagesSquared className={cn('mr-1 w-[0.875rem]', iconClass)} />,
      },
    ],
  };

  if (!endpoint) {
    return null;
  }

  if (endpoint === EModelEndpoint.google && !showExamplesButton) {
    return null;
  }

  const additionalButtons: { [key: string]: TPopoverButton[] } = {
    [SettingsViews.default]: [
      {
        label: 'Context Settings',
        buttonClass: '',
        type: 'alternative',
        handler: () => setSettingsView(SettingsViews.advanced),
        icon: <DataIcon className={cn('mr-1 h-6 w-[0.875rem]', iconClass)} />,
      },
    ],
    [SettingsViews.advanced]: [
      {
        label: 'Model Settings',
        buttonClass: '',
        type: 'alternative',
        handler: () => setSettingsView(SettingsViews.default),
        icon: <AssistantIcon className={cn('mr-1 h-6 w-[0.875rem]', iconClass)} />,
      },
    ],
  };

  const endpointButtons = (endpointSpecificbuttons[endpoint] as TPopoverButton[] | null) ?? [];

  const disabled = true;

  return (
    <div className="flex w-full justify-between">
      <div className="flex items-center justify-start">
        {endpointButtons.map((button, index) => (
          <Button
            key={`button-${index}`}
            type="button"
            className={cn(
              button.buttonClass,
              'border-border-medium focus:ring-ring-primary border focus:ring-1',
              'text-text-primary hover:bg-surface-hover ml-1 h-full bg-transparent px-2 py-1 text-xs font-normal',
              buttonClass ?? '',
            )}
            onClick={button.handler}
          >
            {button.icon}
            {button.label}
          </Button>
        ))}
      </div>
      {disabled ? null : (
        <div className="flex w-[9.375rem] items-center justify-end">
          {additionalButtons[settingsView].map((button, index) => (
            <Button
              key={`button-${index}`}
              type="button"
              className={cn(
                button.buttonClass,
                'border-border-medium focus:ring-ring-primary flex justify-center border focus:ring-1',
                'text-text-primary hover:bg-surface-hover h-full w-full bg-transparent px-2 py-1 text-xs font-normal',
                buttonClass ?? '',
              )}
              onClick={button.handler}
            >
              {button.icon}
              {button.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
