import React from 'react';
import * as Ariakit from '@ariakit/react';
import { ChevronDown } from 'lucide-react';
import { DropdownPopup, Skeleton } from '@librechat/client';
import { AccessRoleIds, ResourceType } from 'librechat-data-provider';
import { useGetAccessRolesQuery } from 'librechat-data-provider/react-query';
import type { AccessRole } from 'librechat-data-provider';
import type * as t from '~/common';
import { cn, getRoleLocalizationKeys, RESOURCE_CONFIGS } from '~/utils';
import { useLocalize } from '~/hooks';

interface AccessRolesPickerProps {
  id?: string;
  ariaLabel?: string;
  resourceType?: ResourceType;
  selectedRoleId?: AccessRoleIds;
  onRoleChange: (roleId: AccessRoleIds) => void;
  className?: string;
}

export default function AccessRolesPicker({
  id,
  ariaLabel,
  resourceType = ResourceType.AGENT,
  selectedRoleId = AccessRoleIds.AGENT_VIEWER,
  onRoleChange,
  className = '',
}: AccessRolesPickerProps) {
  const localize = useLocalize();
  const menuId = React.useId();
  const [isOpen, setIsOpen] = React.useState(false);
  const { data: accessRoles, isLoading: rolesLoading } = useGetAccessRolesQuery(resourceType);

  /** Helper function to get localized role name and description */
  const getLocalizedRoleInfo = (roleId: AccessRoleIds) => {
    const keys = getRoleLocalizationKeys(roleId);
    return {
      name: localize(keys.name),
      description: localize(keys.description),
    };
  };

  const ownerRoleId = RESOURCE_CONFIGS[resourceType]?.defaultOwnerRoleId;
  const filteredRoles =
    resourceType === ResourceType.SHARED_LINK
      ? (accessRoles || []).filter((role) => role.accessRoleId !== ownerRoleId)
      : accessRoles || [];

  const selectedRole = accessRoles?.find((role) => role.accessRoleId === selectedRoleId);
  const selectedRoleInfo = selectedRole ? getLocalizedRoleInfo(selectedRole.accessRoleId) : null;

  if (rolesLoading || !accessRoles) {
    return <Skeleton className="h-10 w-24 rounded-lg" />;
  }

  const dropdownItems: t.MenuItemProps[] = filteredRoles.map((role: AccessRole) => {
    const localizedInfo = getLocalizedRoleInfo(role.accessRoleId);
    return {
      id: role.accessRoleId,
      label: localizedInfo.name,
      onClick: () => {
        onRoleChange(role.accessRoleId);
        setIsOpen(false);
      },
      render: (props) => (
        <button {...props}>
          <div className="flex flex-col items-start gap-0.5 text-left">
            <span className="text-text-primary font-medium">{localizedInfo.name}</span>
            <span className="text-text-secondary text-xs">{localizedInfo.description}</span>
          </div>
        </button>
      ),
    };
  });

  return (
    <div className={className}>
      <DropdownPopup
        menuId={`access-roles-menu-${menuId}`}
        isOpen={isOpen}
        setIsOpen={setIsOpen}
        trigger={
          <Ariakit.MenuButton
            id={id}
            aria-label={
              ariaLabel || selectedRoleInfo?.description || localize('com_ui_role_select')
            }
            className={cn(
              'border-border-light hover:bg-surface-tertiary flex items-center justify-between gap-2 rounded-xl border bg-transparent px-3 py-2 text-sm transition-colors',
            )}
          >
            <span className="font-medium">
              {selectedRoleInfo?.name || localize('com_ui_select')}
            </span>
            <ChevronDown className="text-text-secondary h-4 w-4" aria-hidden="true" />
          </Ariakit.MenuButton>
        }
        items={dropdownItems}
        className="w-[min(17.5rem,90vw)]"
      />
    </div>
  );
}
