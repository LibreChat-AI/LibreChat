import React, { useMemo } from 'react';
import { TooltipAnchor } from '@librechat/client';
import { EModelEndpoint, getConfigDefaults } from 'librechat-data-provider';
import type { ModelSelectorProps } from '~/common';
import {
  renderModelSpecs,
  renderEndpoints,
  renderSearchResults,
  renderCustomGroups,
} from './components';
import { ModelSelectorProvider, useModelSelectorContext } from './ModelSelectorContext';
import { useShortcutAriaKey, useShortcutHint } from '~/hooks/useKeyboardShortcuts';
import { ModelSelectorChatProvider } from './ModelSelectorChatContext';
import CertifiedIcon from '~/components/Agents/CertifiedIcon';
import { getSelectedIcon, getDisplayValue } from './utils';
import { CustomMenu as Menu } from './CustomMenu';
import DialogManager from './DialogManager';
import { useLocalize } from '~/hooks';

const defaultInterface = getConfigDefaults().interface;

function ModelSelectorContent() {
  const localize = useLocalize();
  const modelSelectorHint = useShortcutHint('openModelSelector', localize('com_ui_select_model'));
  const modelSelectorAriaKey = useShortcutAriaKey('openModelSelector');

  const {
    // LibreChat
    agentsMap,
    modelSpecs,
    mappedEndpoints,
    endpointsConfig,
    // State
    searchValue,
    searchResults,
    selectedValues,
    // Functions
    setSearchValue,
    setSelectedValues,
    // Dialog
    keyDialogOpen,
    onOpenChange,
    keyDialogEndpoint,
  } = useModelSelectorContext();
  const selectedIsCertifiedAgent =
    !selectedValues.modelSpec &&
    selectedValues.endpoint === EModelEndpoint.agents &&
    selectedValues.model != null &&
    agentsMap?.[selectedValues.model]?.is_certified === true;

  const selectedIcon = useMemo(
    () =>
      getSelectedIcon({
        mappedEndpoints: mappedEndpoints ?? [],
        selectedValues,
        modelSpecs,
        endpointsConfig,
        agentsMap,
      }),
    [mappedEndpoints, selectedValues, modelSpecs, endpointsConfig, agentsMap],
  );
  const selectedDisplayValue = useMemo(
    () =>
      getDisplayValue({
        localize,
        agentsMap,
        modelSpecs,
        selectedValues,
        mappedEndpoints,
      }),
    [localize, agentsMap, modelSpecs, selectedValues, mappedEndpoints],
  );

  const trigger = (
    <TooltipAnchor
      aria-label={localize('com_ui_select_model')}
      description={modelSelectorHint}
      render={
        <button
          data-testid="model-selector-button"
          aria-keyshortcuts={modelSelectorAriaKey}
          className="border-border-chrome bg-presentation text-text-primary hover:bg-surface-active-alt rounded-theme-control my-1 flex h-9 max-w-full items-center gap-2 border px-3 py-2 text-sm"
          aria-label={localize('com_ui_select_model')}
        >
          {selectedIcon && React.isValidElement(selectedIcon) && (
            <div className="flex shrink-0 items-center justify-center overflow-hidden">
              {selectedIcon}
            </div>
          )}
          <span className="truncate text-start">{selectedDisplayValue}</span>
          {selectedIsCertifiedAgent && <CertifiedIcon static />}
        </button>
      }
    />
  );

  return (
    <div className="relative flex max-w-[60vw] min-w-0 flex-col items-center gap-2 sm:max-w-xs">
      <div className="flex w-full min-w-0 items-center gap-1">
        <div className="min-w-0 flex-1">
          <Menu
            values={selectedValues}
            onValuesChange={(values: Record<string, any>) => {
              setSelectedValues({
                endpoint: values.endpoint || '',
                model: values.model || '',
                modelSpec: values.modelSpec || '',
              });
            }}
            onSearch={(value) => setSearchValue(value)}
            combobox={<input id="model-search" placeholder=" " />}
            comboboxLabel={localize('com_endpoint_search_models')}
            trigger={trigger}
          >
            {searchResults ? (
              renderSearchResults(searchResults, localize, searchValue)
            ) : (
              <>
                {renderModelSpecs(
                  modelSpecs?.filter((spec) => !spec.group) || [],
                  selectedValues.modelSpec || '',
                )}
                {renderEndpoints(mappedEndpoints ?? [])}
                {renderCustomGroups(modelSpecs || [], mappedEndpoints ?? [])}
              </>
            )}
          </Menu>
        </div>
      </div>
      <DialogManager
        keyDialogOpen={keyDialogOpen}
        onOpenChange={onOpenChange}
        endpointsConfig={endpointsConfig || {}}
        keyDialogEndpoint={keyDialogEndpoint || undefined}
      />
    </div>
  );
}

export default function ModelSelector({ startupConfig }: ModelSelectorProps) {
  const interfaceConfig = startupConfig?.interface ?? defaultInterface;
  const modelSpecs = startupConfig?.modelSpecs?.list ?? [];

  // Hide the selector when modelSelect is false and there are no model specs to show
  if (interfaceConfig.modelSelect === false && modelSpecs.length === 0) {
    return null;
  }

  return (
    <ModelSelectorChatProvider>
      <ModelSelectorProvider startupConfig={startupConfig}>
        <ModelSelectorContent />
      </ModelSelectorProvider>
    </ModelSelectorChatProvider>
  );
}
