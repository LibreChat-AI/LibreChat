import React from 'react';
import { EndpointMenuContent, renderSearchResults } from '.';
import type { TModelSpec } from 'librechat-data-provider';
import type { Endpoint, SelectedValues } from '~/common';
import { CustomMenu as Menu } from '../CustomMenu';
import { useLocalize } from '~/hooks';

interface EndpointMenuContentByModeProps {
  mode: 'flat' | 'auto' | 'nested' | undefined;
  selectedValues: SelectedValues;
  onValuesChange: (values: Record<string, any>) => void;
  setSearchValue: (value: string) => void;
  mappedEndpoints: Endpoint[];
  searchResults: (Endpoint | TModelSpec)[] | null;
  searchValue: string;
  trigger: React.JSX.Element;
}

export const isFlatEndpointDropdown = (
  mode: string | undefined,
  mappedEndpoints: Endpoint[],
): boolean => {
  return mode === 'flat' || (mode === 'auto' && mappedEndpoints.length === 1);
};

export function EndpointMenuContentByMode({
  mode,
  selectedValues,
  onValuesChange,
  setSearchValue,
  searchResults,
  searchValue,
  trigger,
  mappedEndpoints,
}: EndpointMenuContentByModeProps) {
  const localize = useLocalize();

  if (mode === 'nested' || !mode) {
    return null;
  }

  let content: React.ReactNode = null;

  if (mode === 'flat') {
    content = searchResults
      ? renderSearchResults(searchResults, localize, searchValue)
      : mappedEndpoints.map((endpoint, index) => (
          <EndpointMenuContent key={endpoint.value} endpoint={endpoint} endpointIndex={index} />
        ));
  } else if (mode === 'auto' && mappedEndpoints.length === 1) {
    content = searchResults ? (
      renderSearchResults(searchResults, localize, searchValue)
    ) : (
      <EndpointMenuContent endpoint={mappedEndpoints[0]} endpointIndex={0} />
    );
  } else {
    return null;
  }

  return content ? (
    <div className="relative flex w-full max-w-md flex-col items-center gap-2">
      <Menu
        values={selectedValues}
        onValuesChange={onValuesChange}
        onSearch={setSearchValue}
        combobox={<input id="model-search" placeholder=" " />}
        comboboxLabel={localize('com_endpoint_search_models')}
        trigger={trigger}
      >
        {content}
      </Menu>
    </div>
  ) : null;
}
