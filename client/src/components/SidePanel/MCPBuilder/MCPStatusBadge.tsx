import { Spinner } from '@librechat/client';
import { Check, KeyRound, Zap } from 'lucide-react';
import type { MCPServerStatus } from 'librechat-data-provider';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

interface MCPStatusBadgeProps {
  serverStatus?: MCPServerStatus;
  isInitializing?: boolean;
  className?: string;
}

/**
 * Status badge component for MCP servers - used in dialogs where text status is needed.
 *
 * Unified color system:
 * - Green: Connected/Active (success)
 * - Blue: Connecting/In-progress or request-scoped on-demand
 * - Amber: Needs user action (OAuth required)
 * - Gray: Disconnected/Inactive (neutral)
 * - Red: Error
 */
export default function MCPStatusBadge({
  serverStatus,
  isInitializing = false,
  className,
}: MCPStatusBadgeProps) {
  const localize = useLocalize();

  const badgeBaseClass = cn(
    'flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium',
    className,
  );

  // Initializing/Connecting state - blue
  if (isInitializing) {
    return (
      <div
        role="status"
        aria-live="polite"
        className={cn(badgeBaseClass, 'bg-status-info-subtle text-status-info')}
      >
        <Spinner className="size-3" />
        <span>{localize('com_nav_mcp_status_initializing')}</span>
      </div>
    );
  }

  if (!serverStatus) {
    return null;
  }

  const { connectionState, requiresOAuth } = serverStatus;

  // Connecting state - blue
  if (connectionState === 'connecting') {
    return (
      <div
        role="status"
        aria-live="polite"
        className={cn(badgeBaseClass, 'bg-status-info-subtle text-status-info')}
      >
        <Spinner className="size-3" />
        <span>{localize('com_nav_mcp_status_connecting')}</span>
      </div>
    );
  }

  if (serverStatus.requestScoped) {
    return (
      <div role="status" className={cn(badgeBaseClass, 'bg-status-info-subtle text-status-info')}>
        <Zap className="size-3" aria-hidden="true" />
        <span>{localize('com_nav_mcp_status_on_demand')}</span>
      </div>
    );
  }

  // Disconnected state - check if needs action
  if (connectionState === 'disconnected') {
    if (requiresOAuth) {
      // Needs OAuth - amber (requires action)
      return (
        <div
          role="status"
          className={cn(badgeBaseClass, 'bg-status-warning-subtle text-status-warning')}
        >
          {/* Credentials, the same glyph the config dialog puts on this state and
              the row puts on the control that supplies them. A plug belongs to the
              action that connects, not to the state of not being able to. */}
          <KeyRound className="size-3" aria-hidden="true" />
          <span>{localize('com_nav_mcp_status_needs_auth')}</span>
        </div>
      );
    }
    // Simply disconnected - gray (neutral)
    return (
      <div
        role="status"
        className={cn(badgeBaseClass, 'bg-status-neutral-subtle text-status-neutral')}
      >
        <span>{localize('com_nav_mcp_status_disconnected')}</span>
      </div>
    );
  }

  // Error state - red
  if (connectionState === 'error') {
    return (
      <div role="status" className={cn(badgeBaseClass, 'bg-status-error-subtle text-status-error')}>
        <span>{localize('com_nav_mcp_status_error')}</span>
      </div>
    );
  }

  // Connected state - green
  if (connectionState === 'connected') {
    return (
      <div
        role="status"
        className={cn(badgeBaseClass, 'bg-status-success-subtle text-status-success')}
      >
        <Check className="size-3" aria-hidden="true" />
        <span>{localize('com_nav_mcp_status_connected')}</span>
      </div>
    );
  }

  return null;
}

/**
 * Returns the status dot color class - unified across all MCP components.
 *
 * Colors:
 * - Green: Connected
 * - Blue: Connecting/Initializing or request-scoped on-demand
 * - Amber: Needs action (OAuth required while disconnected)
 * - Gray: Disconnected (neutral)
 * - Red: Error
 */
export function getStatusDotColor(
  serverStatus?: MCPServerStatus,
  isInitializing?: boolean,
): string {
  if (isInitializing) {
    return 'bg-status-info';
  }

  if (!serverStatus) {
    return 'bg-status-neutral';
  }

  const { connectionState, requiresOAuth } = serverStatus;

  if (connectionState === 'connecting') {
    return 'bg-status-info';
  }

  if (serverStatus.requestScoped) {
    return 'bg-status-info';
  }

  if (connectionState === 'connected') {
    return 'bg-status-success';
  }

  if (connectionState === 'error') {
    return 'bg-status-error';
  }

  if (connectionState === 'disconnected') {
    if (requiresOAuth) {
      return 'bg-status-warning';
    }
    return 'bg-status-neutral';
  }

  return 'bg-status-neutral';
}
