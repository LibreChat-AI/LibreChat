import { Check } from 'lucide-react';
import * as Ariakit from '@ariakit/react';
import { MCPIcon } from '@librechat/client';
import type { MCPServerDefinition } from '~/hooks/MCP/useMCPServerManager';
import type { MCPServerStatusIconProps } from './MCPServerStatusIcon';
import {
  getStatusColor,
  getStatusTextKey,
  shouldShowActionButton,
  type ConnectionStatusMap,
} from './mcpServerUtils';
import MCPServerStatusIcon from './MCPServerStatusIcon';
import CustomIcon from '~/components/ui/CustomIcon';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

interface MCPServerMenuItemProps {
  server: MCPServerDefinition;
  isSelected: boolean;
  connectionStatus?: ConnectionStatusMap;
  isInitializing?: (serverName: string) => boolean;
  statusIconProps?: MCPServerStatusIconProps | null;
  onToggle: (serverName: string) => void;
}

export default function MCPServerMenuItem({
  server,
  isSelected,
  connectionStatus,
  isInitializing,
  statusIconProps,
  onToggle,
}: MCPServerMenuItemProps) {
  const localize = useLocalize();
  const displayName = server.config?.title || server.serverName;
  const statusColor = getStatusColor(server.serverName, connectionStatus, isInitializing);
  const statusTextKey = getStatusTextKey(server.serverName, connectionStatus, isInitializing);
  const statusText = localize(statusTextKey as Parameters<typeof localize>[0]);
  const showActionButton = shouldShowActionButton(statusIconProps);

  // Include status in aria-label so screen readers announce it
  const accessibleLabel = `${displayName}, ${statusText}`;

  return (
    <Ariakit.MenuItemCheckbox
      hideOnClick={false}
      name="mcp-servers"
      value={server.serverName}
      checked={isSelected}
      onChange={() => onToggle(server.serverName)}
      aria-label={accessibleLabel}
      className={cn(
        'group flex w-full cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2',
        'outline-none transition-all duration-150',
        'hover:bg-surface-hover data-[active-item]:bg-surface-hover',
        isSelected && 'bg-surface-active-alt',
      )}
    >
      {/* Server Icon with Status Dot */}
      <div className="relative flex-shrink-0">
        {server.config?.iconPath ? (
          <CustomIcon
            src={server.config.iconPath}
            className="h-8 w-8 rounded-lg object-cover text-text-primary"
            alt=""
          />
        ) : (
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-surface-tertiary">
            <MCPIcon className="h-5 w-5 text-text-secondary" />
          </div>
        )}
        {/* Status dot - decorative, status is announced via aria-label on MenuItem */}
        <div
          aria-hidden="true"
          className={cn(
            'absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-surface-secondary',
            statusColor,
          )}
        />
      </div>

      {/* Server Info */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium text-text-primary">{displayName}</span>
        </div>
        {server.config?.description && (
          <p className="truncate text-xs text-text-secondary">{server.config.description}</p>
        )}
      </div>

      {/* Action Button - only show when actionable */}
      {showActionButton && statusIconProps && (
        <div className="flex-shrink-0" onClick={(e) => e.stopPropagation()}>
          <MCPServerStatusIcon {...statusIconProps} />
        </div>
      )}

      {/* Selection Indicator - purely visual, state conveyed by aria-checked on MenuItem */}
      <span
        aria-hidden="true"
        className={cn(
          'flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-sm border',
          isSelected
            ? 'border-border-xheavy bg-surface-inverted text-text-inverted'
            : 'border-border-xheavy bg-transparent',
        )}
      >
        {isSelected && <Check className="h-4 w-4" />}
      </span>
    </Ariakit.MenuItemCheckbox>
  );
}
