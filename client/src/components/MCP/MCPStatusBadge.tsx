import { Spinner } from '@librechat/client';
import { Check, KeyRound, Zap } from 'lucide-react';
import type { MCPServerStatus } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks/useLocalize';
import { getStatusColor, getStatusTextKey } from '~/components/MCP/mcpServerUtils';
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

  if (!serverStatus && !isInitializing) return null;
  const statuses = serverStatus ? { server: serverStatus } : undefined;
  const color = getStatusColor('server', statuses, () => isInitializing);
  const label = getStatusTextKey('server', statuses, () => isInitializing) as TranslationKeys;
  const variants: Record<string, string> = {
    'bg-status-info': 'bg-status-info-subtle text-status-info',
    'bg-status-warning': 'bg-status-warning-subtle text-status-warning',
    'bg-status-success': 'bg-status-success-subtle text-status-success',
    'bg-status-error': 'bg-status-error-subtle text-status-error',
    'bg-status-neutral': 'bg-status-neutral-subtle text-status-neutral',
  };
  const pending = isInitializing || serverStatus?.connectionState === 'connecting';
  const icons: Record<string, typeof Check> = {
    'bg-status-warning': KeyRound,
    'bg-status-success': Check,
    'bg-status-info': Zap,
  };
  const Icon = pending ? Spinner : icons[color];

  return (
    <div role="status" aria-live="polite" className={cn(badgeBaseClass, variants[color])}>
      {Icon && <Icon className="size-3" aria-hidden="true" />}
      <span>{localize(label)}</span>
    </div>
  );
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
  return getStatusColor('server', serverStatus ? { server: serverStatus } : undefined, () =>
    Boolean(isInitializing),
  );
}
