import React from 'react';
import { Globe, Shield } from 'lucide-react';
import { ResourceType } from 'librechat-data-provider';
import { Switch, InfoHoverCard, ESide, Label } from '@librechat/client';
import type { AccessRoleIds } from 'librechat-data-provider';
import AccessRolesPicker from './AccessRolesPicker';
import { Collapse } from '~/components/ui';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

interface PublicSharingToggleProps {
  isPublic: boolean;
  publicRole?: AccessRoleIds;
  onPublicToggle: (isPublic: boolean) => void;
  onPublicRoleChange: (role: AccessRoleIds) => void;
  resourceType?: ResourceType;
  className?: string;
}

const accessDescriptions: Partial<
  Record<
    ResourceType,
    'com_ui_agent' | 'com_ui_prompt' | 'com_ui_mcp_server' | 'com_ui_skill' | 'com_ui_shared_link'
  >
> = {
  [ResourceType.AGENT]: 'com_ui_agent',
  [ResourceType.PROMPTGROUP]: 'com_ui_prompt',
  [ResourceType.MCPSERVER]: 'com_ui_mcp_server',
  [ResourceType.REMOTE_AGENT]: 'com_ui_agent',
  [ResourceType.SKILL]: 'com_ui_skill',
  [ResourceType.SHARED_LINK]: 'com_ui_shared_link',
};

export default function PublicSharingToggle({
  isPublic,
  publicRole,
  onPublicToggle,
  onPublicRoleChange,
  resourceType = ResourceType.AGENT,
  className,
}: PublicSharingToggleProps) {
  const localize = useLocalize();

  const handleToggle = React.useCallback(
    (checked: boolean) => {
      onPublicToggle(checked);
    },
    [onPublicToggle],
  );

  return (
    <div className={className}>
      {/* Main toggle section */}
      <div className="group relative rounded-lg">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div
              className={cn(
                'transition-colors duration-200',
                isPublic ? 'text-status-info' : 'text-text-secondary',
              )}
            >
              <Globe className="size-5" />
            </div>
            <div className="flex items-center gap-2">
              <Label
                htmlFor="share-everyone-toggle"
                className="cursor-pointer text-sm font-medium text-text-primary"
              >
                {localize('com_ui_share_everyone')}
              </Label>
              <InfoHoverCard
                side={ESide.Top}
                text={localize('com_ui_share_everyone_description_var', {
                  resource:
                    localize(accessDescriptions[resourceType] ?? 'com_ui_resource') ||
                    localize('com_ui_resource'),
                })}
              />
            </div>
          </div>
          <Switch
            id="share-everyone-toggle"
            checked={isPublic}
            onCheckedChange={handleToggle}
            aria-label={localize('com_ui_share_everyone')}
          />
        </div>
      </div>

      <Collapse open={isPublic} overflowVisibleWhenOpen className="pt-4">
        <div className="flex items-center justify-between bg-transparent">
          <div className="flex items-center gap-3">
            <div className="text-status-info">
              <Shield className="size-5" />
            </div>
            <div className="flex flex-col gap-0.5">
              <Label htmlFor="permission-level" className="text-sm font-medium text-text-primary">
                {localize('com_ui_everyone_permission_level')}
              </Label>
            </div>
          </div>
          <div className="relative z-50">
            <AccessRolesPicker
              id="permission-level"
              ariaLabel={localize('com_ui_everyone_permission_level')}
              resourceType={resourceType}
              selectedRoleId={publicRole}
              onRoleChange={onPublicRoleChange}
            />
          </div>
        </div>
      </Collapse>
    </div>
  );
}
