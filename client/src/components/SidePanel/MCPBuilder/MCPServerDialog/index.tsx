import React, { useState, useEffect } from 'react';
import { Copy, CopyCheck } from 'lucide';
import {
  SystemRoles,
  Permissions,
  ResourceType,
  PermissionBits,
  PermissionTypes,
} from 'librechat-data-provider';
import {
  Label,
  Input,
  Button,
  Spinner,
  MorphIcon,
  TrashIcon,
  useToastContext,
  OGDialog,
  OGDialogTitle,
  OGDialogHeader,
  OGDialogFooter,
  OGDialogContent,
  OGDialogTemplate,
} from '@librechat/client';
import { useAuthContext, useHasAccess, useResourcePermissions, MCPServerDefinition } from '~/hooks';
import { GenericGrantAccessDialog } from '~/components/Sharing';
import { useMCPServerForm } from './hooks/useMCPServerForm';
import { useLocalize, useCopyToClipboard } from '~/hooks';
import MCPServerForm from './MCPServerForm';

interface MCPServerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children?: React.ReactNode;
  triggerRef?: React.MutableRefObject<HTMLDivElement | HTMLButtonElement | null>;
  server?: MCPServerDefinition | null;
}

export default function MCPServerDialog({
  open,
  onOpenChange,
  children,
  triggerRef,
  server,
}: MCPServerDialogProps) {
  const localize = useLocalize();
  const { user } = useAuthContext();
  const { showToast } = useToastContext();

  // State for dialogs
  const [isCopying, setIsCopying] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showRedirectUriDialog, setShowRedirectUriDialog] = useState(false);
  const [createdServerId, setCreatedServerId] = useState<string | null>(null);

  // Form hook
  const formHook = useMCPServerForm({
    server,
    onSuccess: (serverName, isOAuth) => {
      if (isOAuth) {
        setCreatedServerId(serverName);
        setShowRedirectUriDialog(true);
      } else {
        onOpenChange(false);
        setTimeout(() => {
          triggerRef?.current?.focus();
        }, 0);
      }
    },
    onClose: () => {
      onOpenChange(false);
      setTimeout(() => {
        triggerRef?.current?.focus();
      }, 0);
    },
  });

  const { isEditMode, isSubmitting, isDeleting, onSubmit, handleDelete, resetForm } = formHook;

  // Reset form when dialog opens
  useEffect(() => {
    if (open) {
      resetForm();
    }
  }, [open, resetForm]);

  // Permissions
  const hasAccessToShareMcpServers = useHasAccess({
    permissionType: PermissionTypes.MCP_SERVERS,
    permission: Permissions.SHARE,
  });

  const { hasPermission, isLoading: permissionsLoading } = useResourcePermissions(
    ResourceType.MCPSERVER,
    server?.dbId || '',
  );

  const canShareThisServer = hasPermission(PermissionBits.SHARE);

  const shouldShowShareButton =
    server &&
    (user?.role === SystemRoles.ADMIN || canShareThisServer) &&
    hasAccessToShareMcpServers &&
    !permissionsLoading;

  const redirectUri = createdServerId
    ? `${window.location.origin}/api/mcp/${createdServerId}/oauth/callback`
    : '';

  const copyLink = useCopyToClipboard({ text: redirectUri });

  return (
    <>
      {/* Delete confirmation dialog */}
      <OGDialog open={showDeleteConfirm} onOpenChange={(isOpen) => setShowDeleteConfirm(isOpen)}>
        <OGDialogTemplate
          title={localize('com_ui_delete_mcp_server')}
          className="w-11/12 max-w-md"
          description={localize('com_ui_mcp_server_delete_confirm', { 0: server?.serverName })}
          selection={
            <Button
              onClick={handleDelete}
              variant="destructive"
              aria-live="polite"
              aria-label={isDeleting ? localize('com_ui_deleting') : localize('com_ui_delete')}
            >
              {isDeleting ? <Spinner /> : localize('com_ui_delete')}
            </Button>
          }
        />
      </OGDialog>

      {/* Post-creation redirect URI dialog */}
      <OGDialog
        open={showRedirectUriDialog}
        onOpenChange={(isOpen) => {
          setShowRedirectUriDialog(isOpen);
          if (!isOpen) {
            onOpenChange(false);
            setCreatedServerId(null);
          }
        }}
      >
        <OGDialogContent showCloseButton={false} className="w-11/12 max-w-lg">
          <OGDialogHeader>
            <OGDialogTitle>{localize('com_ui_mcp_server_created')}</OGDialogTitle>
          </OGDialogHeader>
          <div className="space-y-4">
            <p className="text-sm">{localize('com_ui_redirect_uri_instructions')}</p>

            <div className="space-y-2">
              <Label htmlFor="redirect-uri-input" className="text-sm font-medium">
                {localize('com_ui_redirect_uri')}
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  id="redirect-uri-input"
                  type="text"
                  readOnly
                  value={redirectUri}
                  className="flex-1 text-text-secondary"
                />
                <Button
                  size="icon"
                  variant="outline"
                  onClick={() => {
                    if (isCopying) return;
                    if (!copyLink(setIsCopying)) return;
                    showToast({ message: localize('com_ui_copied_to_clipboard') });
                  }}
                  disabled={isCopying || !redirectUri}
                  className="p-0"
                  aria-label={localize('com_ui_copy_link')}
                >
                  <MorphIcon icon={isCopying ? CopyCheck : Copy} className="size-4" />
                </Button>
              </div>
            </div>
            <OGDialogFooter>
              <Button
                variant="default"
                onClick={() => {
                  setShowRedirectUriDialog(false);
                  onOpenChange(false);
                  setCreatedServerId(null);
                }}
              >
                {localize('com_ui_done')}
              </Button>
            </OGDialogFooter>
          </div>
        </OGDialogContent>
      </OGDialog>

      {/* Main Dialog */}
      <OGDialog open={open} onOpenChange={onOpenChange} triggerRef={triggerRef}>
        {children}
        <OGDialogTemplate
          title={
            isEditMode ? localize('com_ui_edit_mcp_server') : localize('com_ui_add_mcp_server')
          }
          description={
            isEditMode
              ? localize('com_ui_edit_mcp_server_dialog_description', {
                  serverName: server?.serverName || '',
                })
              : undefined
          }
          showCloseButton={false}
          className="w-11/12 md:max-w-3xl"
          main={<MCPServerForm formHook={formHook} />}
          footerClassName="sm:justify-between"
          leftButtons={
            isEditMode ? (
              <div className="flex items-center gap-2">
                <Button
                  variant="destructive"
                  size="sm"
                  aria-label={localize('com_ui_delete_mcp_server_name', {
                    0: server?.config?.title || server?.serverName || '',
                  })}
                  onClick={() => setShowDeleteConfirm(true)}
                  disabled={isSubmitting || isDeleting}
                >
                  <TrashIcon aria-hidden="true" />
                </Button>
                {shouldShowShareButton && server && (
                  <GenericGrantAccessDialog
                    resourceDbId={server.dbId}
                    resourceName={server.config.title || ''}
                    resourceType={ResourceType.MCPSERVER}
                  />
                )}
              </div>
            ) : null
          }
          buttons={
            <Button
              type="button"
              variant={isEditMode ? 'default' : 'submit'}
              onClick={onSubmit}
              disabled={isSubmitting}
              aria-live="polite"
              aria-label={
                isSubmitting
                  ? localize(isEditMode ? 'com_ui_updating' : 'com_ui_creating')
                  : localize(isEditMode ? 'com_ui_update_mcp_server' : 'com_ui_create_mcp_server')
              }
            >
              {isSubmitting ? (
                <Spinner className="size-4" />
              ) : (
                localize(isEditMode ? 'com_ui_update' : 'com_ui_create')
              )}
            </Button>
          }
        />
      </OGDialog>
    </>
  );
}
