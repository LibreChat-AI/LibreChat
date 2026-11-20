import { useMemo } from 'react';
import { presetSettings, getSettingsKeys, applyModelAwareDefaults } from 'librechat-data-provider';
import type { SettingDefinition } from 'librechat-data-provider';
import type { TModelSelectProps } from '~/common';
import { componentMapping } from '~/components/SidePanel/Parameters/components';
import { useModelReasoning } from '~/hooks/Endpoint/useModelReasoning';
import { useGetEndpointsQuery } from '~/data-provider';

export default function OpenAISettings({
  conversation,
  setOption,
  models,
  readonly,
}: TModelSelectProps) {
  const { data: endpointsConfig } = useGetEndpointsQuery();
  const { modelReasoning } = useModelReasoning(
    endpointsConfig,
    conversation?.endpoint ?? '',
    conversation?.model ?? '',
  );
  const parameters = useMemo(() => {
    const [combinedKey, endpointKey] = getSettingsKeys(
      conversation?.endpointType ?? conversation?.endpoint ?? '',
      conversation?.model ?? '',
    );
    const settings = presetSettings[combinedKey] ?? presetSettings[endpointKey];
    if (!settings) {
      return undefined;
    }
    /** A custom endpoint's own parameter set (e.g. OpenRouter's) decides its model-aware defaults. */
    const paramsKey =
      endpointsConfig?.[conversation?.endpoint ?? '']?.customParams?.defaultParamsEndpoint ??
      endpointKey;
    return {
      col1: applyModelAwareDefaults(
        settings.col1,
        paramsKey,
        conversation?.model ?? undefined,
        endpointsConfig?.[conversation?.endpoint ?? '']?.responsesApiRouting,
        modelReasoning,
      ),
      col2: applyModelAwareDefaults(
        settings.col2,
        paramsKey,
        conversation?.model ?? undefined,
        endpointsConfig?.[conversation?.endpoint ?? '']?.responsesApiRouting,
        modelReasoning,
      ),
    };
  }, [conversation, endpointsConfig, modelReasoning]);

  if (!parameters) {
    return null;
  }

  const renderComponent = (setting: SettingDefinition | undefined) => {
    if (!setting) {
      return null;
    }
    const Component = componentMapping[setting.component];
    if (!Component) {
      return null;
    }
    const { key, default: defaultValue, ...rest } = setting;

    const props = {
      settingKey: key,
      defaultValue,
      ...rest,
      readonly,
      setOption,
      conversation,
    };

    if (key === 'model') {
      return <Component key={key} {...props} options={models} />;
    }

    return <Component key={key} {...props} />;
  };

  return (
    <div className="h-auto max-w-full overflow-x-hidden p-3">
      <div className="grid grid-cols-1 gap-6 md:grid-cols-5">
        <div className="flex flex-col gap-6 md:col-span-3">
          {parameters.col1.map(renderComponent)}
        </div>
        <div className="flex flex-col gap-6 md:col-span-2">
          {parameters.col2.map(renderComponent)}
        </div>
      </div>
    </div>
  );
}
