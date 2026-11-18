import React from 'react';
import { KeyRound, PlugZap, X } from 'lucide-react';
import { Button, Spinner, TooltipAnchor } from '@librechat/client';
import type { MCPServerStatus } from 'librechat-data-provider';
import type { MCPConnectionView } from '~/hooks/MCP/connection';
import { getMCPConnectionView } from '~/hooks/MCP/connection';
import { getStatusColor } from './mcpServerUtils';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

let localize: ReturnType<typeof useLocalize>;

interface StatusIconProps {
  serverName: string;
  onConfigClick: (e: React.MouseEvent) => void;
}

interface InitializingStatusProps extends StatusIconProps {
  onCancel: (e: React.MouseEvent) => void;
  canCancel: boolean;
}

export interface MCPServerStatusIconProps {
  serverName: string;
  serverStatus?: MCPServerStatus;
  view?: MCPConnectionView;
  onConfigClick: (e: React.MouseEvent) => void;
  isInitializing: boolean;
  canCancel: boolean;
  onCancel: (e: React.MouseEvent) => void;
  hasCustomUserVars?: boolean;
  /** When true, renders as a small status dot for compact layouts */
  compact?: boolean;
}

/**
 * Renders the appropriate status icon for an MCP server based on its state.
 *
 * Unified icon system:
 * - PlugZap: making the connection (for disconnected servers)
 * - KeyRound: the credentials the server asks this user for
 * - Spinner: Loading state (during connection)
 * - X: Cancel (during OAuth flow, shown on hover over spinner)
 */
export default function MCPServerStatusIcon({
  serverName,
  serverStatus,
  view,
  onConfigClick,
  isInitializing,
  canCancel,
  onCancel,
  hasCustomUserVars = false,
  compact = false,
}: MCPServerStatusIconProps) {
  localize = useLocalize();

  const presentation =
    view ??
    getMCPConnectionView(serverStatus, undefined, undefined, { initializing: isInitializing });
  if (compact)
    return (
      <CompactStatusDot
        serverStatus={serverStatus}
        isInitializing={isInitializing}
        view={presentation}
      />
    );
  if (presentation.state === 'connecting') {
    return canCancel ? (
      <LoadingStatusIcon
        serverName={serverName}
        onConfigClick={onConfigClick}
        onCancel={onCancel}
        canCancel={canCancel}
      />
    ) : (
      <ConnectingSpinner serverName={serverName} />
    );
  }
  if (presentation.requestScoped) {
    return hasCustomUserVars ? (
      <ConfigureButton serverName={serverName} onConfigClick={onConfigClick} />
    ) : null;
  }
  if (presentation.state === 'succeeded') {
    return hasCustomUserVars ? (
      <ConfigureButton serverName={serverName} onConfigClick={onConfigClick} />
    ) : (
      <ConnectButton
        serverName={serverName}
        onConfigClick={onConfigClick}
        label={localize('com_nav_mcp_reconnect')}
      />
    );
  }
  if (presentation.state === 'connected' || presentation.state === 'authorized') {
    return hasCustomUserVars ? (
      <ConfigureButton serverName={serverName} onConfigClick={onConfigClick} />
    ) : null;
  }
  if (!serverStatus && !view) return null;
  return <ConnectButton serverName={serverName} onConfigClick={onConfigClick} />;
}

interface CompactStatusDotProps {
  view?: MCPConnectionView;
  serverStatus?: MCPServerStatus;
  isInitializing: boolean;
}

function CompactStatusDot({ serverStatus, isInitializing, view }: CompactStatusDotProps) {
  if (isInitializing || view?.state === 'connecting') {
    return (
      <div className="border-surface-secondary bg-status-info flex size-3.5 items-center justify-center rounded-full border-2">
        <div className="bg-text-on-status size-1.5 animate-pulse rounded-full" />
      </div>
    );
  }
  return (
    <div
      className={cn(
        'border-surface-secondary size-3 rounded-full border-2',
        getStatusColor(
          'server',
          serverStatus ? { server: serverStatus } : undefined,
          undefined,
          view,
        ),
      )}
    />
  );
}

function LoadingStatusIcon({ serverName, onCancel, canCancel }: InitializingStatusProps) {
  if (canCancel) {
    return (
      <TooltipAnchor
        description={localize('com_ui_cancel')}
        render={
          <Button
            variant="ghost"
            size="icon"
            onClick={onCancel}
            className="group hover:bg-status-error-subtle size-6 rounded p-1"
            aria-label={localize('com_ui_cancel')}
          >
            <div className="relative size-4">
              <Spinner tone="primary" className="size-4 group-hover:opacity-0" />
              <X className="text-text-destructive absolute inset-0 size-4 opacity-0 group-hover:opacity-100" />
            </div>
          </Button>
        }
      />
    );
  }

  return (
    <div className="flex size-6 items-center justify-center rounded p-1">
      <Spinner
        tone="primary"
        className="size-4"
        aria-label={localize('com_nav_mcp_status_connecting', { 0: serverName })}
      />
    </div>
  );
}

function ConnectingSpinner({ serverName }: { serverName: string }) {
  return (
    <div className="flex size-6 items-center justify-center rounded p-1">
      <Spinner
        tone="primary"
        className="size-4"
        aria-label={localize('com_nav_mcp_status_connecting', { 0: serverName })}
      />
    </div>
  );
}

/** Connect button - shown for disconnected/error states. Uses PlugZap icon. */
function ConnectButton({ serverName, onConfigClick, label }: StatusIconProps & { label?: string }) {
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={onConfigClick}
      className="hover:bg-surface-secondary size-6 rounded p-1"
      aria-label={
        label ? `${label} ${serverName}` : localize('com_nav_mcp_connect_server', { 0: serverName })
      }
    >
      <PlugZap className="text-text-secondary size-4" aria-hidden="true" />
    </Button>
  );
}

/** Configure button - shown for connected servers with custom vars. Uses KeyRound icon. */
function ConfigureButton({ serverName, onConfigClick }: StatusIconProps) {
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={onConfigClick}
      className="hover:bg-surface-secondary size-6 rounded p-1"
      aria-label={localize('com_nav_mcp_configure_server', { 0: serverName })}
    >
      <KeyRound className="text-text-secondary size-4" aria-hidden="true" />
    </Button>
  );
}
