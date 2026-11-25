import { useMemo, useState } from 'react';
import { useAtom } from 'jotai';
import { ChevronDown } from 'lucide-react';
import { Switch } from '@librechat/client';
import { alternateName, isAgentsEndpoint, isAssistantsEndpoint } from 'librechat-data-provider';
import type { TConfig } from 'librechat-data-provider';
import type { ModelVisibility } from '~/utils/modelVisibility';
import {
  emptyModelVisibility,
  isEndpointConfigured,
  isEndpointVisible,
  isModelVisible,
  withEndpointVisible,
  withModelVisible,
} from '~/utils/modelVisibility';
import { useGetEndpointsQuery, useModelCatalog } from '~/data-provider';
import { modelVisibilityAtom } from '~/store/modelVisibility';
import { mapEndpoints, cn } from '~/utils';
import { useLocalize } from '~/hooks';

function endpointLabel(endpoint: string, config?: TConfig | null): string {
  return config?.modelDisplayLabel ?? alternateName[endpoint] ?? endpoint;
}

function isCatalogEndpoint(endpoint: string): boolean {
  return !isAgentsEndpoint(endpoint) && !isAssistantsEndpoint(endpoint);
}

export default function ModelVisibility() {
  const localize = useLocalize();
  const [visibility, setVisibility] = useAtom(modelVisibilityAtom);
  const { data: endpointsConfig } = useGetEndpointsQuery();
  const endpoints = useMemo(() => mapEndpoints(endpointsConfig ?? {}), [endpointsConfig]);
  const catalog = useModelCatalog(undefined, { endpoints, eager: true });
  const [expanded, setExpanded] = useState<string | null>(null);

  const hasOverrides =
    Object.keys(visibility.endpoints ?? {}).length > 0 ||
    Object.keys(visibility.models ?? {}).length > 0;
  const update = (next: ModelVisibility) => setVisibility(next);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <p className="text-text-secondary text-xs">
          {localize('com_ui_model_visibility_description')}
        </p>
        {hasOverrides && (
          <button
            type="button"
            onClick={() => update(emptyModelVisibility)}
            className="text-text-secondary hover:text-text-primary focus-visible:ring-border-xheavy shrink-0 rounded-md px-1.5 py-0.5 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:outline-hidden"
          >
            {localize('com_ui_model_visibility_reset')}
          </button>
        )}
      </div>
      <ul className="divide-border-light flex flex-col divide-y">
        {endpoints.map((endpoint) => {
          const config = endpointsConfig?.[endpoint];
          const visible = isEndpointVisible(endpoint, config, visibility);
          const configured = isEndpointConfigured(config);
          const label = endpointLabel(endpoint, config);
          const labelId = `model-visibility-endpoint-${endpoint}-label`;
          const models = isCatalogEndpoint(endpoint) ? catalog.data[endpoint] : undefined;
          const isExpanded = expanded === endpoint;

          return (
            <li key={endpoint} className="flex flex-col gap-2 py-2.5 first:pt-0 last:pb-0">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <div className="flex min-w-0 items-center gap-2">
                    <span id={labelId} className="text-text-primary truncate text-sm">
                      {label}
                    </span>
                    {!configured && (
                      <span className="bg-surface-tertiary text-text-secondary text-2xs rounded-full px-2 py-0.5 leading-4">
                        {localize('com_ui_model_visibility_unconfigured')}
                      </span>
                    )}
                  </div>
                  {models != null && models.length > 0 && (
                    <button
                      type="button"
                      aria-expanded={isExpanded}
                      aria-controls={`model-visibility-models-${endpoint}`}
                      onClick={() => setExpanded(isExpanded ? null : endpoint)}
                      className="text-text-secondary hover:text-text-primary focus-visible:ring-border-xheavy flex w-fit items-center gap-1 rounded-md text-xs transition-colors focus-visible:ring-2 focus-visible:outline-hidden"
                    >
                      {localize('com_ui_model_visibility_models', { 0: models.length })}
                      <ChevronDown
                        className={cn(
                          'size-3.5 transition-transform duration-150',
                          isExpanded && 'rotate-180',
                        )}
                        aria-hidden="true"
                      />
                    </button>
                  )}
                </div>
                <Switch
                  id={`model-visibility-endpoint-${endpoint}`}
                  checked={visible}
                  onCheckedChange={(checked) =>
                    update(withEndpointVisible(visibility, endpoint, checked))
                  }
                  aria-labelledby={labelId}
                  className="ms-4 shrink-0"
                />
              </div>
              {isExpanded && models != null && (
                <ul
                  id={`model-visibility-models-${endpoint}`}
                  className="border-border-light flex max-h-64 flex-col overflow-y-auto rounded-lg border px-2 py-1"
                >
                  {models.map((model) => {
                    const modelId = `model-visibility-model-${endpoint}-${model}`;
                    return (
                      <li key={model} className="flex items-center justify-between gap-3 py-1.5">
                        <span
                          id={`${modelId}-label`}
                          className="text-text-secondary truncate text-xs"
                        >
                          {model}
                        </span>
                        <Switch
                          id={modelId}
                          checked={isModelVisible(endpoint, model, visibility)}
                          onCheckedChange={(checked) =>
                            update(withModelVisible(visibility, endpoint, model, checked))
                          }
                          aria-labelledby={`${modelId}-label`}
                          className="ms-4 shrink-0"
                        />
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
