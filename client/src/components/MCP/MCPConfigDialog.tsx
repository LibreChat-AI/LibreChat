import React, { useMemo } from 'react';
import { KeyRound, PlugZap, AlertTriangle } from 'lucide-react';
import {
  Spinner,
  OGDialog,
  OGDialogTitle,
  OGDialogHeader,
  OGDialogContent,
} from '@librechat/client';
import type { MCPServerStatus } from 'librechat-data-provider';
import type { ConfigFieldDetail } from '~/common';
import ServerInitializationSection from './ServerInitializationSection';
import CustomUserVarsSection from './CustomUserVarsSection';
import { useLocalize } from '~/hooks';

interface MCPConfigDialogProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  fieldsSchema: Record<string, ConfigFieldDetail>;
  initialValues: Record<string, string>;
  onSave: (updatedValues: Record<string, string>) => void;
  isSubmitting?: boolean;
  onRevoke?: () => void;
  serverName: string;
  serverStatus?: MCPServerStatus;
  conversationId?: string | null;
  storageContextKey?: string;
}

export default function MCPConfigDialog({
  isOpen,
  onOpenChange,
  fieldsSchema,
  onSave,
  isSubmitting = false,
  onRevoke,
  serverName,
  serverStatus,
  conversationId,
  storageContextKey,
}: MCPConfigDialogProps) {
  const localize = useLocalize();

  const hasFields = Object.keys(fieldsSchema).length > 0;
  const dialogTitle = hasFields
    ? localize('com_ui_configure_mcp_variables_for', { 0: serverName })
    : `${serverName} MCP Server`;

  const fullTitle = useMemo(() => {
    if (!serverStatus) {
      return localize('com_ui_mcp_dialog_title', {
        serverName,
        status: '',
      });
    }

    const { connectionState, requiresOAuth } = serverStatus;
    let statusText = '';

    if (connectionState === 'connecting') {
      statusText = localize('com_ui_connecting');
    } else if (connectionState === 'error') {
      statusText = localize('com_ui_error');
    } else if (connectionState === 'connected') {
      statusText = localize('com_ui_active');
    } else if (connectionState === 'disconnected') {
      statusText = requiresOAuth ? localize('com_ui_oauth') : localize('com_ui_offline');
    }

    return localize('com_ui_mcp_dialog_title', {
      serverName,
      status: statusText,
    });
  }, [serverStatus, serverName, localize]);

  /**
   * Render status badge with unified color system:
   * - Blue: Connecting/In-progress
   * - Amber: Needs action (OAuth required)
   * - Gray: Disconnected (neutral/inactive)
   * - Green: Connected (success)
   * - Red: Error
   */
  const renderStatusBadge = () => {
    if (!serverStatus) {
      return null;
    }

    const { connectionState, requiresOAuth } = serverStatus;

    // Connecting: blue (in progress)
    if (connectionState === 'connecting') {
      return (
        <div className="bg-status-info-subtle text-status-info flex items-center gap-2 rounded-full px-2 py-0.5 text-xs font-medium">
          <Spinner className="size-3" />
          <span>{localize('com_ui_connecting')}</span>
        </div>
      );
    }

    // Disconnected: check if needs action
    if (connectionState === 'disconnected') {
      if (requiresOAuth) {
        // Needs OAuth: amber (requires action)
        return (
          <div className="bg-status-warning-subtle text-status-warning flex items-center gap-2 rounded-full px-2 py-0.5 text-xs font-medium">
            <KeyRound className="size-3" aria-hidden="true" />
            <span>{localize('com_nav_mcp_status_needs_auth')}</span>
          </div>
        );
      }
      // Simply disconnected: gray (neutral)
      return (
        <div className="bg-status-neutral-subtle text-status-neutral flex items-center gap-2 rounded-full px-2 py-0.5 text-xs font-medium">
          <PlugZap className="size-3" aria-hidden="true" />
          <span>{localize('com_nav_mcp_status_disconnected')}</span>
        </div>
      );
    }

    // Error: red
    if (connectionState === 'error') {
      return (
        <div className="bg-status-error-subtle text-status-error flex items-center gap-2 rounded-full px-2 py-0.5 text-xs font-medium">
          <AlertTriangle className="size-3" aria-hidden="true" />
          <span>{localize('com_ui_error')}</span>
        </div>
      );
    }

    // Connected: green
    if (connectionState === 'connected') {
      return (
        <div className="bg-status-success-subtle text-status-success flex items-center gap-2 rounded-full px-2 py-0.5 text-xs font-medium">
          <div className="bg-status-success size-1.5 rounded-full" />
          <span>{localize('com_ui_active')}</span>
        </div>
      );
    }

    return null;
  };

  return (
    <OGDialog open={isOpen} onOpenChange={onOpenChange}>
      <OGDialogContent
        className="flex max-h-screen w-11/12 max-w-lg flex-col space-y-2"
        title={fullTitle}
      >
        <OGDialogHeader>
          <div className="flex items-center gap-3">
            <OGDialogTitle className="text-xl">
              {dialogTitle.charAt(0).toUpperCase() + dialogTitle.slice(1)}
            </OGDialogTitle>
            {renderStatusBadge()}
          </div>
        </OGDialogHeader>

        {/* Custom User Variables Section */}
        <CustomUserVarsSection
          serverName={serverName}
          fields={fieldsSchema}
          onSave={onSave}
          onRevoke={onRevoke || (() => {})}
          isSubmitting={isSubmitting}
        />

        {/* Server Initialization Section */}
        <ServerInitializationSection
          serverName={serverName}
          conversationId={conversationId}
          storageContextKey={storageContextKey}
          requiresOAuth={serverStatus?.requiresOAuth || false}
          hasCustomUserVars={fieldsSchema && Object.keys(fieldsSchema).length > 0}
        />
      </OGDialogContent>
    </OGDialog>
  );
}
