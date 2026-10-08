import { useEffect, useMemo, useRef } from 'react';
import {
  getEndpointField,
  getSettingsKeys,
  presetSettings,
  applyModelAwareDefaults,
  clampSettingRange,
} from 'librechat-data-provider';
import type { SettingsConfiguration, SettingDefinition } from 'librechat-data-provider';
import type { TModelSelectProps } from '~/common';
import { componentMapping } from '~/components/SidePanel/Parameters/components';
import { useGetEndpointsQuery } from '~/data-provider';

export default function GoogleSettings({
  conversation,
  setOption,
  models,
  readonly,
}: TModelSelectProps) {
  const { data: endpointsConfig } = useGetEndpointsQuery();

  const parameters = useMemo(() => {
    /** A preset for a Google-compatible endpoint need not carry `endpointType`,
     *  so the configured type is resolved the same way EndpointSettings resolves
     *  it to pick this component. Falling back to the endpoint's custom name
     *  would miss `presetSettings` entirely and blank the panel. */
    const endpointType =
      getEndpointField(endpointsConfig, conversation?.endpoint, 'type') ??
      conversation?.endpointType;
    const model = conversation?.model ?? '';
    const [combinedKey, endpointKey] = getSettingsKeys(
      endpointType ?? conversation?.endpoint ?? '',
      model,
    );
    const columns = presetSettings[combinedKey] ?? presetSettings[endpointKey];
    if (!columns) {
      return undefined;
    }

    /** Google's max output token ceiling moved with Gemini 2.5/3, so the raw
     *  definition's default is stale for current models. */
    const withModelDefaults = (settings: SettingsConfiguration) =>
      applyModelAwareDefaults(settings, endpointKey, model);

    const col1 = withModelDefaults(columns.col1);
    const col2 = withModelDefaults(columns.col2);

    return { col1, col2 };
  }, [conversation?.endpoint, conversation?.endpointType, conversation?.model, endpointsConfig]);

  /** Only the rendered definition follows the model; the value already stored
   *  in the preset does not. Switching a 2.5 Pro preset to Flash would leave a
   *  32,768 thinking budget in place, past the new ceiling, and Save would
   *  persist it without the untouched field ever being focused. */
  const appliedModelRef = useRef<string | undefined>(conversation?.model ?? undefined);
  const model = conversation?.model ?? undefined;
  useEffect(() => {
    if (appliedModelRef.current === model) {
      return;
    }
    appliedModelRef.current = model;
    if (!parameters || !setOption) {
      return;
    }
    for (const setting of [...parameters.col1, ...parameters.col2]) {
      if (setting == null || setting.type !== 'number' || setting.range == null) {
        continue;
      }
      /** Same marker the field-level clamp uses: a model that does not narrow
       *  this parameter leaves the shared fallback range in place. */
      if (setting.range.modelSpecific !== true) {
        continue;
      }
      const stored = conversation?.[setting.key];
      if (typeof stored !== 'number') {
        continue;
      }
      const clamped = clampSettingRange(stored, setting.range);
      if (clamped !== stored) {
        setOption(setting.key)(clamped);
      }
    }
  }, [model, parameters, conversation, setOption]);

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
      key,
      settingKey: key,
      defaultValue,
      ...rest,
      readonly,
      setOption,
      conversation,
    };

    if (key === 'model') {
      return <Component {...props} options={models} />;
    }

    return <Component {...props} />;
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
