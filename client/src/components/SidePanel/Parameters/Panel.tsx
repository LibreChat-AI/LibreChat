import React, { useId, useMemo, useState, useEffect, useCallback } from 'react';
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
import { groupParameters, countModified, hasControl, isWideParameter } from './groups';
import { useGetEndpointsQuery, useGetStartupConfig } from '~/data-provider';
import { useChatContext, useLiveAnnouncer } from '~/Providers';
import { SaveAsPresetDialog } from '~/components/Endpoints';
import { useSetIndexOptions, useLocalize } from '~/hooks';
import { componentMapping } from './components';
import { logger, cn } from '~/utils';

export default function Parameters() {
  const panelId = useId();
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

  /** Region choices come from the deployment, so they are filled in before grouping,
   *  and a control left with nothing to render is dropped there too: a section is
   *  built only from controls that show something. */
  const sections = useMemo(
    () =>
      groupParameters(
        visibleParameters
          .map((setting) =>
            setting.key === 'region' && bedrockRegions.length > 0
              ? { ...setting, options: bedrockRegions }
              : setting,
          )
          .filter((setting) => componentMapping[setting.component] != null && hasControl(setting)),
      ),
    [visibleParameters, bedrockRegions],
  );

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
    <div className="h-auto max-w-full px-3 pt-1 pb-3">
      {/* Every parameter this model can act on is on screen. A disclosure would
          trade the one thing a settings panel is for, seeing the current state at a
          glance, for vertical space that pairing and quieter headings give back
          anyway. */}
      {sections.map((section) => {
        const changed = countModified(section.settings, conversation);
        const headingId = `${panelId}-${section.id}`;

        return (
          <section key={section.id} aria-labelledby={headingId} className="pt-4 first:pt-0">
            <h3
              id={headingId}
              className="text-text-secondary mb-2 flex items-center gap-1.5 text-xs font-semibold tracking-wide uppercase"
            >
              <span className="truncate">{localize(section.label)}</span>
              {/* Where this conversation's own answers are, which is what the owner
                  scans for before reaching for Reset. */}
              {changed > 0 && (
                <>
                  <span
                    aria-hidden="true"
                    className="bg-surface-tertiary text-text-primary shrink-0 rounded-full px-1.5 text-xs font-normal tracking-normal normal-case tabular-nums"
                  >
                    {changed}
                  </span>
                  <span className="sr-only">
                    {localize(
                      changed === 1
                        ? 'com_ui_params_changed_count_one'
                        : 'com_ui_params_changed_count',
                      { count: changed },
                    )}
                  </span>
                </>
              )}
            </h3>
            <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
              {section.settings.map((setting) => {
                const Component = componentMapping[setting.component];
                if (!Component) {
                  return null;
                }
                const { key, default: defaultValue, ...rest } = setting;

                /** The cell owns the span, not the control. The definitions carry a
                 *  columnSpan written for the four-column preset dialog, which says
                 *  nothing about a panel this narrow. */
                /** The cell stretches its control to the row, so a pair whose labels
                 *  wrap differently still lines their inputs up. Applied here rather
                 *  than in the shared controls, which the preset editors reuse. */
                return (
                  <div
                    key={key}
                    className={cn(
                      '*:h-full',
                      isWideParameter(setting) ? 'col-span-2' : 'col-span-1',
                    )}
                  >
                    <Component
                      settingKey={key}
                      defaultValue={defaultValue}
                      {...rest}
                      setOption={setOption}
                      conversation={conversation}
                    />
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
      {/* The two share a row while their labels fit, stack when a translation is too
          long for the panel, and a label longer than the panel itself wraps. */}
      <div className="mt-5 flex flex-wrap gap-2">
        <Button
          variant="outline"
          type="button"
          onClick={resetParameters}
          aria-label={localize('com_ui_reset_var', { 0: localize('com_ui_model_parameters') })}
          className="flex h-auto min-h-9 flex-auto items-center justify-center whitespace-normal active:scale-[0.98] motion-reduce:transform-none"
        >
          <RotateCcw
            key={resetCount}
            className={cn(
              'h-4 w-4 shrink-0 motion-reduce:animate-none',
              resetCount > 0 && 'animate-reset-spin',
            )}
            aria-hidden="true"
          />
          {localize('com_ui_reset')}
        </Button>
        <Button
          variant="default"
          onClick={openDialog}
          className="flex h-auto min-h-9 flex-auto items-center justify-center font-semibold whitespace-normal"
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
