import React, { useMemo, useState, useEffect, useCallback } from 'react';
import keyBy from 'lodash/keyBy';
import { RotateCcw } from 'lucide-react';
import { Button } from '@librechat/client';
import {
  excludedKeys,
  paramSettings,
  getSettingsKeys,
  getEndpointField,
  SettingDefinition,
  tConvoUpdateSchema,
  applyModelAwareDefaults,
  normalizeEndpointName,
  resolveDropParamsUIKeys,
} from 'librechat-data-provider';
import type { TPreset } from 'librechat-data-provider';
import { useGetEndpointsQuery, useGetStartupConfig } from '~/data-provider';
import { useChatContext, useLiveAnnouncer } from '~/Providers';
import { SaveAsPresetDialog } from '~/components/Endpoints';
import { useSetIndexOptions, useLocalize } from '~/hooks';
import { componentMapping } from './components';
import { logger, cn } from '~/utils';

export default function Parameters() {
  const localize = useLocalize();
  const { data: startupConfig } = useGetStartupConfig();
  const { conversation, setConversation } = useChatContext();
  const { announcePolite } = useLiveAnnouncer();
  const { setOption } = useSetIndexOptions();

  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [preset, setPreset] = useState<TPreset | null>(null);
  /** Bumped on every reset; used as a key so the spin animation replays */
  const [resetCount, setResetCount] = useState(0);

  const { data: endpointsConfig = {} } = useGetEndpointsQuery();
  const provider = conversation?.endpoint ?? '';
  const model = conversation?.model ?? '';

  const bedrockRegions = useMemo(() => {
    return endpointsConfig?.[conversation?.endpoint ?? '']?.availableRegions ?? [];
  }, [endpointsConfig, conversation?.endpoint]);

  const endpointType = useMemo(
    () => getEndpointField(endpointsConfig, conversation?.endpoint, 'type'),
    [conversation?.endpoint, endpointsConfig],
  );

  const { parameters, visibleParameters } = useMemo(() => {
    const customParams = endpointsConfig[provider]?.customParams ?? {};
    const [combinedKey, endpointKey] = getSettingsKeys(endpointType ?? provider, model);
    const overriddenEndpointKey = customParams.defaultParamsEndpoint ?? endpointKey;
    const dropParamsMap = startupConfig?.endpointsDropParamsMap;
    const dropParamsEntry =
      dropParamsMap?.[provider] ?? dropParamsMap?.[normalizeEndpointName(provider)];
    const resolvedDropParams = Array.isArray(dropParamsEntry)
      ? dropParamsEntry
      : dropParamsEntry?.[model];
    const dropParamsSet = resolveDropParamsUIKeys(
      Array.isArray(resolvedDropParams) ? resolvedDropParams : undefined,
      overriddenEndpointKey,
    );
    const defaultParams = paramSettings[combinedKey] ?? paramSettings[overriddenEndpointKey] ?? [];
    const overriddenParams = endpointsConfig[provider]?.customParams?.paramDefinitions ?? [];
    const overriddenParamsMap = keyBy(overriddenParams, 'key');
    /** Model visibility must not determine which stored settings survive pruning.
     * Explicit administrator drops still remove a key from both sets. */
    const parameters = defaultParams.filter(
      (param) => param != null && !dropParamsSet.has(param.key),
    );
    const visibleParameters = applyModelAwareDefaults(
      parameters,
      overriddenEndpointKey,
      model,
      endpointsConfig?.[provider ?? '']?.responsesApiRouting,
    ).map((param) => (overriddenParamsMap[param.key] as SettingDefinition) ?? param);
    return { parameters, visibleParameters };
  }, [endpointType, endpointsConfig, model, provider, startupConfig]);

  useEffect(() => {
    if (!parameters) {
      return;
    }

    // const defaultValueMap = new Map();
    // const paramKeys = new Set(
    //   parameters.map((setting) => {
    //     if (setting.default != null) {
    //       defaultValueMap.set(setting.key, setting.default);
    //     }
    //     return setting.key;
    //   }),
    // );
    const paramKeys = new Set(
      parameters.filter((setting) => setting != null).map((setting) => setting.key),
    );
    setConversation((prev) => {
      if (!prev) {
        return prev;
      }

      const updatedConversation = { ...prev };

      const conversationKeys = Object.keys(updatedConversation);
      const updatedKeys: string[] = [];
      conversationKeys.forEach((key) => {
        // const defaultValue = defaultValueMap.get(key);
        // if (paramKeys.has(key) && defaultValue != null && prev[key] != null) {
        //   updatedKeys.push(key);
        //   updatedConversation[key] = defaultValue;
        //   return;
        // }

        if (paramKeys.has(key)) {
          return;
        }

        if (excludedKeys.has(key)) {
          return;
        }

        if (prev[key] != null) {
          updatedKeys.push(key);
          delete updatedConversation[key];
        }
      });

      if (updatedKeys.length === 0) {
        return prev;
      }

      logger.log('parameters', 'parameters effect, updated keys:', updatedKeys);

      return updatedConversation;
    });
  }, [parameters, setConversation]);

  const resetParameters = useCallback(() => {
    setConversation((prev) => {
      if (!prev) {
        return prev;
      }

      const updatedConversation = { ...prev };
      const resetKeys: string[] = [];

      Object.keys(updatedConversation).forEach((key) => {
        if (excludedKeys.has(key)) {
          return;
        }

        if (updatedConversation[key] !== undefined) {
          resetKeys.push(key);
          delete updatedConversation[key];
        }
      });

      logger.log('parameters', 'parameters reset, affected keys:', resetKeys);
      return updatedConversation;
    });

    announcePolite({ message: localize('com_ui_model_parameters_reset'), isStatus: true });

    setResetCount((count) => count + 1);
  }, [setConversation, announcePolite, localize]);

  const openDialog = useCallback(() => {
    const newPreset = tConvoUpdateSchema.parse({
      ...conversation,
    }) as TPreset;
    setPreset(newPreset);
    setIsDialogOpen(true);
  }, [conversation]);

  if (!parameters) {
    return null;
  }

  return (
    <div className="h-auto max-w-full px-3 pb-3 pt-2">
      <div className="grid grid-cols-2 gap-4">
        {' '}
        {/* This is the parent element containing all settings */}
        {/* Below is an example of an applied dynamic setting, each be contained by a div with the column span specified */}
        {visibleParameters.map((setting) => {
          const Component = componentMapping[setting.component];
          if (!Component) {
            return null;
          }
          const { key, default: defaultValue, ...rest } = setting;

          if (key === 'region' && bedrockRegions.length) {
            rest.options = bedrockRegions;
          }

          return (
            <Component
              key={key}
              settingKey={key}
              defaultValue={defaultValue}
              {...rest}
              setOption={setOption}
              conversation={conversation}
            />
          );
        })}
      </div>
      <div className="mt-4 flex justify-center">
        <Button
          variant="outline"
          type="button"
          onClick={resetParameters}
          className="flex w-full items-center justify-center gap-2 px-4 py-2 text-sm active:scale-[0.98] motion-reduce:transform-none"
        >
          <RotateCcw
            key={resetCount}
            className={cn(
              'h-4 w-4 motion-reduce:animate-none',
              resetCount > 0 && 'animate-reset-spin',
            )}
            aria-hidden="true"
          />
          {localize('com_ui_reset_var', { 0: localize('com_ui_model_parameters') })}
        </Button>
      </div>
      <div className="mt-2 flex justify-center">
        <Button
          variant="default"
          onClick={openDialog}
          className="flex w-full items-center justify-center px-4 py-2 font-semibold"
          type="button"
        >
          {localize('com_endpoint_save_as_preset')}
        </Button>
      </div>
      {preset && (
        <SaveAsPresetDialog open={isDialogOpen} onOpenChange={setIsDialogOpen} preset={preset} />
      )}
    </div>
  );
}
