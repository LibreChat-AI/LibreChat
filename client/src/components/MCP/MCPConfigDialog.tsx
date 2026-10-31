import React, { useMemo } from 'react';
import { OGDialog, OGDialogTitle, OGDialogHeader, OGDialogContent } from '@librechat/client';
import type { MCPServerStatus } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks/useLocalize';
import type { ConfigFieldDetail } from '~/common';
import ServerInitializationSection from './ServerInitializationSection';
import CustomUserVarsSection from './CustomUserVarsSection';
import { getStatusTextKey } from './mcpServerUtils';
import MCPStatusBadge from './MCPStatusBadge';
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

    const statusText = localize(
      getStatusTextKey(serverName, { [serverName]: serverStatus }) as TranslationKeys,
    );

    return localize('com_ui_mcp_dialog_title', {
      serverName,
      status: statusText,
    });
  }, [serverStatus, serverName, localize]);

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
            <MCPStatusBadge serverStatus={serverStatus} />
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
