import React from 'react';
import { RefreshCw, Trash2 } from 'lucide-react';
import { Button, Spinner } from '@librechat/client';
import { useLocalize, useMCPServerManager } from '~/hooks';
import { useMCPRefresh } from '~/hooks/MCP/useMCPRefresh';
import { openInNewTab } from '~/utils';

interface ServerInitializationSectionProps {
  sidePanel?: boolean;
  serverName: string;
  requiresOAuth: boolean;
  hasCustomUserVars?: boolean;
  conversationId?: string | null;
  storageContextKey?: string;
}

export default function ServerInitializationSection({
  serverName,
  requiresOAuth,
  conversationId,
  storageContextKey,
  sidePanel = false,
  hasCustomUserVars = false,
}: ServerInitializationSectionProps) {
  const localize = useLocalize();

  const {
    getOAuthUrl,
    isCancellable,
    isInitializing,
    cancelOAuthFlow,
    initializeServer,
    availableMCPServers,
    availableMCPServersMap,
    connectionStatus,
    revokeOAuthForServer,
  } = useMCPServerManager({
    conversationId,
    storageContextKey,
    observeToolAuthorization: true,
  });

  useMCPRefresh({ enabled: availableMCPServers.length > 0 });

  const serverStatus = connectionStatus?.[serverName];
  const isConnected = serverStatus?.connectionState === 'connected';
  const hasPendingOAuth =
    requiresOAuth &&
    serverStatus?.requiresOAuth === true &&
    serverStatus.connectionState === 'connecting';
  const canCancel = isCancellable(serverName) || hasPendingOAuth;
  const isServerInitializing = isInitializing(serverName);
  const serverOAuthUrl = getOAuthUrl(serverName);

  const requestScoped =
    serverStatus?.requestScoped === true ||
    availableMCPServersMap?.[serverName]?.requestScoped === true;
  const shouldShowReinit = isConnected && !requestScoped && (requiresOAuth || hasCustomUserVars);
  /** Saving custom variables makes an on-demand server ready, but it still
   * needs one explicit initialization attempt so callers waiting to attach the
   * runtime wildcard observe `connectionDeferred`. */
  const canDeferRequestScopedConnection =
    requestScoped && hasCustomUserVars && serverStatus?.configurationState === 'configured';
  const shouldShowInit =
    !isConnected &&
    (!requestScoped || canDeferRequestScopedConnection) &&
    !serverOAuthUrl &&
    !hasPendingOAuth;
  const shouldShowRevoke = requiresOAuth && revokeOAuthForServer != null;

  if (!shouldShowReinit && !shouldShowInit && !shouldShowRevoke && !serverOAuthUrl) {
    if (!hasPendingOAuth) {
      return null;
    }

    return (
      <Button
        onClick={() => cancelOAuthFlow(serverName)}
        disabled={!canCancel}
        variant="outline"
        size={sidePanel ? 'sm' : 'default'}
        className="w-full"
      >
        {localize('com_ui_cancel')}
      </Button>
    );
  }

  if (serverOAuthUrl) {
    return (
      <>
        <div className="flex items-center gap-2">
          <Button
            onClick={() => cancelOAuthFlow(serverName)}
            disabled={!canCancel}
            variant="outline"
            title={!canCancel ? 'disabled' : undefined}
          >
            {localize('com_ui_cancel')}
          </Button>
          <Button variant="submit" onClick={() => openInNewTab(serverOAuthUrl)} className="flex-1">
            {localize('com_ui_continue_oauth')}
          </Button>
        </div>
      </>
    );
  }

  // Unified button rendering
  const isReinit = shouldShowReinit;
  const buttonVariant = isReinit ? undefined : 'default';

  let buttonText = '';
  if (isServerInitializing) {
    buttonText = localize('com_ui_loading');
  } else if (isReinit) {
    buttonText = localize('com_ui_reinitialize');
  } else if (requiresOAuth) {
    buttonText = localize('com_ui_authenticate');
  } else {
    buttonText = localize('com_ui_mcp_initialize');
  }

  const icon = isServerInitializing ? (
    <Spinner className="h-4 w-4" />
  ) : (
    <RefreshCw className="h-4 w-4" aria-hidden="true" />
  );

  return (
    <div className="flex items-center gap-2">
      {shouldShowRevoke && (
        <Button
          size="sm"
          variant="destructive"
          onClick={() => revokeOAuthForServer?.(serverName)}
          aria-label={localize('com_ui_revoke')}
        >
          <Trash2 className="h-4 w-4" />
          {localize('com_ui_revoke')}
        </Button>
      )}
      {(shouldShowReinit || shouldShowInit) && (
        <Button
          variant={buttonVariant}
          onClick={() => initializeServer(serverName, false)}
          disabled={isServerInitializing}
          size={sidePanel ? 'sm' : 'default'}
          className="flex-1"
        >
          {icon}
          {buttonText}
        </Button>
      )}
    </div>
  );
}
