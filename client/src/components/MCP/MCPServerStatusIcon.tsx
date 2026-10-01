import React from 'react';
import { KeyRound, PlugZap, X } from 'lucide-react';
import { Button, Spinner, TooltipAnchor } from '@librechat/client';
import type { MCPServerStatus } from 'librechat-data-provider';
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
  onConfigClick,
  isInitializing,
  canCancel,
  onCancel,
  hasCustomUserVars = false,
  compact = false,
}: MCPServerStatusIconProps) {
  localize = useLocalize();

  // Compact mode: render as a small status dot
  if (compact) {
    return <CompactStatusDot serverStatus={serverStatus} isInitializing={isInitializing} />;
  }

  // Loading state: show spinner (with cancel option if available)
  if (isInitializing) {
    return (
      <LoadingStatusIcon
        serverName={serverName}
        onConfigClick={onConfigClick}
        onCancel={onCancel}
        canCancel={canCancel}
      />
    );
  }

  if (!serverStatus) {
    return null;
  }

  const { connectionState, requestScoped } = serverStatus;

  // Connecting: show spinner, with cancel when an OAuth flow is pending.
  if (connectionState === 'connecting') {
    if (canCancel) {
      return (
        <LoadingStatusIcon
          serverName={serverName}
          onConfigClick={onConfigClick}
          onCancel={onCancel}
          canCancel={canCancel}
        />
      );
    }

    return <ConnectingSpinner serverName={serverName} />;
  }

  // Request-scoped servers can only be connected while serving an MCP request.
  if ((connectionState === 'disconnected' || connectionState === 'error') && requestScoped) {
    return hasCustomUserVars ? (
      <ConfigureButton serverName={serverName} onConfigClick={onConfigClick} />
    ) : null;
  }

  // Disconnected or Error: show connect button (PlugZap icon)
  if (connectionState === 'disconnected' || connectionState === 'error') {
    return <ConnectButton serverName={serverName} onConfigClick={onConfigClick} />;
  }

  // Connected: only show config button if there are custom vars to configure
  if (connectionState === 'connected' && hasCustomUserVars) {
    return <ConfigureButton serverName={serverName} onConfigClick={onConfigClick} />;
  }

  // Connected without custom vars: no action needed, status shown via dot
  return null;
}

interface CompactStatusDotProps {
  serverStatus?: MCPServerStatus;
  isInitializing: boolean;
}

function CompactStatusDot({ serverStatus, isInitializing }: CompactStatusDotProps) {
  if (isInitializing) {
    return (
      /** `status-info` rather than `-strong`: the strong slot is a neutral grey
       *  in both standard palettes, so using it turned this blue dot grey. The
       *  pulse takes the on-status ink so it inverts with the fill. */
      <div className="border-surface-secondary bg-status-info flex size-3.5 items-center justify-center rounded-full border-2">
        <div className="bg-text-on-status size-1.5 animate-pulse rounded-full" />
      </div>
    );
  }

  if (!serverStatus) {
    return (
      <div className="border-surface-secondary bg-status-neutral size-3 rounded-full border-2" />
    );
  }

  const { connectionState, requiresOAuth } = serverStatus;

  let colorClass = 'bg-status-neutral';
  if (connectionState === 'connecting') {
    colorClass = 'bg-status-info';
  } else if (serverStatus.requestScoped) {
    colorClass = 'bg-status-info';
  } else if (connectionState === 'connected') {
    colorClass = 'bg-status-success';
  } else if (connectionState === 'error') {
    colorClass = 'bg-status-error';
  } else if (connectionState === 'disconnected' && requiresOAuth) {
    colorClass = 'bg-status-warning';
  }

  return (
    <div className={cn('border-surface-secondary size-3 rounded-full border-2', colorClass)} />
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
              <Spinner className="text-text-primary size-4 group-hover:opacity-0" />
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
        className="text-text-primary size-4"
        aria-label={localize('com_nav_mcp_status_connecting', { 0: serverName })}
      />
    </div>
  );
}

function ConnectingSpinner({ serverName }: { serverName: string }) {
  return (
    <div className="flex size-6 items-center justify-center rounded p-1">
      <Spinner
        className="text-text-primary size-4"
        aria-label={localize('com_nav_mcp_status_connecting', { 0: serverName })}
      />
    </div>
  );
}

/** Connect button - shown for disconnected/error states. Uses PlugZap icon. */
function ConnectButton({ serverName, onConfigClick }: StatusIconProps) {
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={onConfigClick}
      className="hover:bg-surface-secondary size-6 rounded p-1"
      aria-label={localize('com_nav_mcp_connect_server', { 0: serverName })}
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
