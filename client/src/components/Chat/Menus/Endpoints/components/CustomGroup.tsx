import React from 'react';
import type { TModelSpec } from 'librechat-data-provider';
import { useModelSelectorContext } from '../ModelSelectorContext';
import { CustomMenu as Menu } from '../CustomMenu';
import { ModelSpecItem } from './ModelSpecItem';
import GroupIcon from './GroupIcon';

interface CustomGroupProps {
  groupName: string;
  specs: TModelSpec[];
  groupIcon?: string;
}

export function CustomGroup({ groupName, specs, groupIcon }: CustomGroupProps) {
  const { selectedValues } = useModelSelectorContext();
  const { modelSpec: selectedSpec } = selectedValues;

  if (!specs || specs.length === 0) {
    return null;
  }

  return (
    <Menu
      id={`custom-group-${groupName}-menu`}
      key={`custom-group-${groupName}`}
      className="transition-opacity duration-200 ease-in-out"
      label={
        <div className="group flex w-full flex-shrink cursor-pointer items-center justify-between rounded-xl px-1 py-1 text-sm">
          <div className="flex items-center gap-2">
            {groupIcon && (
              <div className="flex-shrink-0" aria-hidden="true">
                <GroupIcon iconURL={groupIcon} groupName={groupName} />
              </div>
            )}
            <span className="truncate text-left">{groupName}</span>
          </div>
        </div>
      }
    >
      {specs.map((spec: TModelSpec) => (
        <ModelSpecItem key={spec.name} spec={spec} isSelected={selectedSpec === spec.name} />
      ))}
    </Menu>
  );
}

export function renderCustomGroups(
  modelSpecs: TModelSpec[],
  mappedEndpoints: Array<{ value: string }>,
) {
  // Get all endpoint values to exclude them from custom groups
  const endpointValues = new Set(mappedEndpoints.map((ep) => ep.value));

  // Group specs by their group field (excluding endpoint-matched groups and ungrouped)
  // Also track the groupIcon for each group (first spec with groupIcon wins)
  const customGroups = modelSpecs.reduce(
    (acc, spec) => {
      if (!spec.group || endpointValues.has(spec.group)) {
        return acc;
      }
      if (!acc[spec.group]) {
        acc[spec.group] = { specs: [], groupIcon: undefined };
      }
      acc[spec.group].specs.push(spec);
      // Use the first groupIcon found for the group
      if (!acc[spec.group].groupIcon && spec.groupIcon) {
        acc[spec.group].groupIcon = spec.groupIcon;
      }
      return acc;
    },
    {} as Record<string, { specs: TModelSpec[]; groupIcon?: string }>,
  );

  // Render each custom group
  return Object.entries(customGroups).map(([groupName, { specs, groupIcon }]) => (
    <CustomGroup key={groupName} groupName={groupName} specs={specs} groupIcon={groupIcon} />
  ));
}
