import React, { useState, useEffect } from 'react';
import { Link, CopyCheck } from 'lucide';
import { Share2Icon, Users, UserCheck, AlertCircle } from 'lucide-react';
import { AccessRoleIds, ResourceType, SystemRoles } from 'librechat-data-provider';
import {
  Alert,
  Label,
  Button,
  Spinner,
  Skeleton,
  OGDialog,
  MorphIcon,
  OGDialogHeader,
  OGDialogFooter,
  OGDialogTitle,
  OGDialogDescription,
  OGDialogContent,
  OGDialogTrigger,
  TooltipAnchor,
  useToastContext,
} from '@librechat/client';
import type { TPrincipal } from 'librechat-data-provider';
import {
  usePeoplePickerPermissions,
  useResourcePermissionState,
  useCopyToClipboard,
  useCanSharePublic,
  useAuthContext,
  useLocalize,
} from '~/hooks';
import { computeShareChanges, dedupeNewShares, principalKey } from './shareChanges';
import UnifiedPeopleSearch from './PeoplePicker/UnifiedPeopleSearch';
import PeoplePickerAdminSettings from './PeoplePickerAdminSettings';
import PublicSharingToggle from './PublicSharingToggle';
import { SelectedPrincipalsList } from './PeoplePicker';
import { cn } from '~/utils';

export default function GenericGrantAccessDialog({
  resourceName,
  resourceDbId,
  resourceId,
  resourceType,
  onGrantAccess,
  disabled = false,
  buttonClassName,
  children,
}: {
  resourceDbId?: string | null;
  resourceId?: string | null;
  resourceName?: string;
  resourceType: ResourceType;
  onGrantAccess?: (shares: TPrincipal[], isPublic: boolean, publicRole?: AccessRoleIds) => void;
  disabled?: boolean;
  buttonClassName?: string;
  children?: React.ReactNode;
}) {
  const localize = useLocalize();
  const { user } = useAuthContext();
  const { showToast } = useToastContext();
  const [isCopying, setIsCopying] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const peopleSectionId = React.useId();
  const ownerErrorId = React.useId();
  const canSharePublic = useCanSharePublic(resourceType);
  const canEditAgentInsights =
    resourceType === ResourceType.AGENT && user?.role === SystemRoles.ADMIN;
  const { hasPeoplePickerAccess, peoplePickerTypeFilter } = usePeoplePickerPermissions();
  const canManagePrincipals = hasPeoplePickerAccess || canEditAgentInsights;

  /** User can use the dialog if they can manage principals or share publicly. */
  const canUseShareDialog = canManagePrincipals || canSharePublic;

  const {
    config,
    permissionsData,
    isLoadingPermissions,
    isFetchingPermissions,
    permissionsError,
    refetchPermissions,
    updatePermissionsMutation,
    currentShares,
    currentIsPublic,
    currentPublicRole,
    isPublic,
    setIsPublic,
    publicRole,
    setPublicRole,
  } = useResourcePermissionState(resourceType, resourceDbId, isModalOpen);

  /** State for unified list of all shares (existing + newly added) */
  const [allShares, setAllShares] = useState<TPrincipal[]>([]);
  const [hasChanges, setHasChanges] = useState(false);
  const [defaultPermissionId, setDefaultPermissionId] = useState<AccessRoleIds | undefined>(
    config?.defaultViewerRoleId,
  );

  // Sync all shares with current shares when modal opens, marking existing vs new
  useEffect(() => {
    if (permissionsData && isModalOpen) {
      const shares = permissionsData.principals || [];
      setAllShares(shares.map((share) => ({ ...share, isExisting: true })));
      setHasChanges(false);
    }
  }, [permissionsData, isModalOpen]);

  const resourceUrl = config?.getResourceUrl ? config?.getResourceUrl(resourceId || '') : '';
  const copyResourceUrl = useCopyToClipboard({ text: resourceUrl });

  if (!resourceDbId) {
    return null;
  }

  // Don't render if user has no useful sharing permissions
  if (!canUseShareDialog) {
    return null;
  }

  if (!config) {
    console.error(`Unsupported resource type: ${resourceType}`);
    return null;
  }

  // Handler for adding users from search (immediate add to unified list)
  const handleAddFromSearch = (newShares: TPrincipal[]) => {
    const sharesToAdd = dedupeNewShares(allShares, newShares);
    if (!sharesToAdd.length) {
      return;
    }

    const sharesWithDefaults = sharesToAdd.map((share) => ({
      ...share,
      accessRoleId: defaultPermissionId || config?.defaultViewerRoleId,
      ...(canEditAgentInsights ? { viewInsights: false } : {}),
      isExisting: false, // Mark as newly added
    }));

    setAllShares((prev) => [...prev, ...sharesWithDefaults]);
    setHasChanges(true);
  };

  // Handler for removing individual shares
  const handleRemoveShare = (shareKey: string) => {
    setAllShares(allShares.filter((share) => principalKey(share) !== shareKey));
    setHasChanges(true);
  };

  // Handler for changing individual share permissions
  const handleRoleChange = (shareKey: string, newRole: string) => {
    setAllShares(
      allShares.map((share) =>
        principalKey(share) === shareKey
          ? { ...share, accessRoleId: newRole as AccessRoleIds }
          : share,
      ),
    );
    setHasChanges(true);
  };

  const handleInsightsChange = (shareKey: string, viewInsights: boolean) => {
    setAllShares(
      allShares.map((share) =>
        principalKey(share) === shareKey ? { ...share, viewInsights } : share,
      ),
    );
    setHasChanges(true);
  };

  // Handler for public access toggle
  const handlePublicToggle = (isPublicValue: boolean) => {
    setIsPublic(isPublicValue);
    setHasChanges(true);
    if (!isPublicValue) {
      setPublicRole(config?.defaultViewerRoleId);
    }
  };

  // Handler for public role change
  const handlePublicRoleChange = (role: string) => {
    setPublicRole(role as AccessRoleIds);
    setHasChanges(true);
  };

  // Save all changes (unified save handler)
  const handleSave = async () => {
    if (!allShares.length && !isPublic && !hasChanges) {
      return;
    }

    try {
      // Diff persisted shares against the working list. Keyed by stable `id`
      // (falling back to idOnTheSource) so the same principal is never simultaneously
      // granted and revoked — see computeShareChanges.
      const { updated, removed } = computeShareChanges(currentShares, allShares);

      const publicChanged = isPublic !== currentIsPublic;
      const publicRoleChanged = isPublic && publicRole !== currentPublicRole;
      const sendPublicUpdate = publicChanged || publicRoleChanged;

      await updatePermissionsMutation.mutateAsync({
        resourceType,
        resourceId: resourceDbId,
        data: {
          updated,
          removed,
          ...(sendPublicUpdate ? { public: isPublic } : {}),
          ...(sendPublicUpdate && isPublic ? { publicAccessRoleId: publicRole } : {}),
        },
      });

      if (onGrantAccess) {
        onGrantAccess(allShares, isPublic, publicRole);
      }

      showToast({
        message: localize('com_ui_permissions_updated_success'),
        status: 'success',
      });

      setHasChanges(false);
    } catch (error) {
      console.error('Error updating permissions:', error);
      showToast({
        message: localize('com_ui_permissions_failed_update'),
        status: 'error',
      });
    }
  };

  const resetDraft = () => {
    const shares = permissionsData?.principals || [];
    setAllShares(shares.map((share) => ({ ...share, isExisting: true })));
    setDefaultPermissionId(config?.defaultViewerRoleId);
    setIsPublic(currentIsPublic);
    setPublicRole(currentPublicRole || config?.defaultViewerRoleId || '');
    setHasChanges(false);
  };

  const handleModalOpenChange = (open: boolean) => {
    if (!open) {
      resetDraft();
    }
    setIsModalOpen(open);
  };

  // Validation and calculated values
  const totalCurrentShares = currentShares.length + (currentIsPublic ? 1 : 0);

  // Check if there's at least one owner (user, group, or public with owner role)
  const hasAtLeastOneOwner =
    allShares.some((share) => share.accessRoleId === config?.defaultOwnerRoleId) ||
    (isPublic && publicRole === config?.defaultOwnerRoleId);

  // Check if there are any changes to save
  const hasPublicChanges = isPublic !== currentIsPublic || publicRole !== currentPublicRole;
  const submitButtonActive = hasChanges || hasPublicChanges;

  // On permissions load failure, keep a compact trigger-sized button so the layout holds,
  // surfacing the error (and a retry on click) through a tooltip.
  if (permissionsError) {
    return (
      <TooltipAnchor
        description={localize('com_ui_permissions_failed_load')}
        render={
          <Button
            size="sm"
            variant="outline"
            type="button"
            disabled={disabled}
            onClick={() => refetchPermissions()}
            aria-label={localize('com_ui_permissions_failed_load')}
            className={cn('h-9', buttonClassName)}
          >
            <div className="flex min-w-[32px] items-center justify-center text-text-destructive">
              <span className="flex h-6 w-6 items-center justify-center">
                {isFetchingPermissions ? (
                  <Spinner className="h-4 w-4" />
                ) : (
                  <AlertCircle className="icon-md h-4 w-4" aria-hidden="true" />
                )}
              </span>
            </div>
          </Button>
        }
      />
    );
  }

  const TriggerComponent = children ? (
    children
  ) : (
    <Button
      size="sm"
      variant="outline"
      aria-label={localize('com_ui_share_var', {
        0: config?.getShareMessage(resourceName),
      })}
      type="button"
      disabled={disabled}
      className={cn('h-9', buttonClassName)}
    >
      <div className="flex min-w-[32px] items-center justify-center gap-2 text-status-info">
        <span className="flex h-6 w-6 items-center justify-center">
          <Share2Icon className="icon-md h-4 w-4" />
        </span>
        {totalCurrentShares > 0 && (
          <Label className="cursor-pointer text-sm font-medium text-text-secondary">
            {totalCurrentShares}
          </Label>
        )}
      </div>
    </Button>
  );

  return (
    <OGDialog open={isModalOpen} onOpenChange={handleModalOpenChange} modal>
      <OGDialogTrigger asChild>{TriggerComponent}</OGDialogTrigger>
      <OGDialogContent className="flex max-h-[90dvh] w-11/12 max-w-5xl flex-col gap-0 overflow-hidden p-0">
        <OGDialogHeader className="shrink-0 px-5 py-5 pr-14 text-left sm:px-6">
          <div className="flex items-start gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-border-light bg-surface-secondary text-text-secondary">
              <Users className="size-5" aria-hidden="true" />
            </div>
            <div className="min-w-0 space-y-1">
              <OGDialogTitle className="truncate text-xl leading-7">
                {localize('com_ui_share_var', {
                  0: config?.getShareMessage(resourceName),
                })}
              </OGDialogTitle>
              <OGDialogDescription className="sr-only">
                {localize('com_ui_share_access_description')}
              </OGDialogDescription>
            </div>
          </div>
        </OGDialogHeader>

        <div
          className="min-h-0 flex-1 overflow-y-auto px-5 py-3 sm:px-6 sm:py-4"
          aria-busy={isLoadingPermissions}
        >
          {canManagePrincipals && (
            <section aria-labelledby={peopleSectionId} className="w-full min-w-0">
              <div className="flex items-center justify-between gap-3 px-1 pb-3">
                <h3
                  id={peopleSectionId}
                  className="flex min-w-0 items-center gap-2 text-sm font-semibold text-text-primary"
                >
                  <UserCheck className="size-4 shrink-0 text-text-secondary" aria-hidden="true" />
                  <span className="truncate">{localize('com_ui_user_group_permissions')}</span>
                </h3>
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-tertiary text-xs font-medium text-text-secondary">
                  {allShares.length}
                </span>
              </div>

              <div className="w-full space-y-3">
                {isLoadingPermissions ? (
                  <div className="space-y-2" aria-live="polite">
                    <span className="sr-only">{localize('com_ui_loading')}</span>
                    <Skeleton className="h-10 w-full rounded-lg" />
                    <Skeleton className="h-[62px] w-full rounded-xl" />
                    <Skeleton className="h-[62px] w-full rounded-xl" />
                  </div>
                ) : (
                  <>
                    <UnifiedPeopleSearch
                      onAddPeople={handleAddFromSearch}
                      label={localize('com_ui_search_people_placeholder')}
                      placeholder={localize('com_ui_search_people_placeholder')}
                      typeFilter={peoplePickerTypeFilter}
                      excludeIds={allShares.map((s) => s.idOnTheSource)}
                    />

                    {!hasAtLeastOneOwner && hasChanges && (
                      <Alert id={ownerErrorId} variant="error">
                        {localize('com_ui_at_least_one_owner_required')}
                      </Alert>
                    )}

                    {allShares.length === 0 ? (
                      <div className="rounded-xl border border-dashed border-border-medium px-5 py-8 text-center">
                        <div className="mx-auto flex size-10 items-center justify-center rounded-full bg-surface-tertiary text-text-secondary">
                          <Users className="size-5" aria-hidden="true" />
                        </div>
                        <p className="mt-3 text-sm font-medium text-text-primary">
                          {localize('com_ui_no_individual_resource_access')}
                        </p>
                        <p className="mt-1 text-xs text-text-secondary">
                          {localize('com_ui_search_above_to_add_people')}
                        </p>
                      </div>
                    ) : (
                      <SelectedPrincipalsList
                        principles={allShares}
                        onRemoveHandler={handleRemoveShare}
                        resourceType={resourceType}
                        onRoleChange={(id, newRole) => handleRoleChange(id, newRole)}
                        showInsightsAccess={canEditAgentInsights}
                        onInsightsAccessChange={handleInsightsChange}
                      />
                    )}
                  </>
                )}
              </div>

              {canSharePublic && (
                <div className="mt-4 border-t border-border-light pt-4">
                  <PublicSharingToggle
                    isPublic={isPublic}
                    publicRole={publicRole}
                    onPublicToggle={handlePublicToggle}
                    onPublicRoleChange={handlePublicRoleChange}
                    resourceType={resourceType}
                  />
                </div>
              )}
            </section>
          )}

          {canSharePublic && !canManagePrincipals && (
            <section className="w-full">
              <PublicSharingToggle
                isPublic={isPublic}
                publicRole={publicRole}
                onPublicToggle={handlePublicToggle}
                onPublicRoleChange={handlePublicRoleChange}
                resourceType={resourceType}
              />
            </section>
          )}
        </div>

        <OGDialogFooter className="shrink-0 gap-3 bg-transparent px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:space-x-0 sm:px-6">
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <PeoplePickerAdminSettings />
            {resourceId && resourceUrl && (
              <TooltipAnchor
                description={
                  isCopying ? config?.getCopyUrlMessage() : localize('com_ui_copy_url_to_clipboard')
                }
                render={
                  <Button
                    variant="outline"
                    onClick={() => {
                      if (isCopying) return;
                      if (!copyResourceUrl(setIsCopying)) return;
                      showToast({
                        message: localize('com_ui_agent_url_copied'),
                        status: 'success',
                      });
                    }}
                    disabled={isCopying}
                    className={cn('shrink-0 gap-2', isCopying ? 'cursor-default' : '')}
                    aria-label={localize('com_ui_copy_url_to_clipboard')}
                  >
                    <MorphIcon icon={isCopying ? CopyCheck : Link} className="size-4" />
                    {isCopying
                      ? config?.getCopyUrlMessage()
                      : localize('com_ui_copy_url_to_clipboard')}
                  </Button>
                }
              />
            )}
          </div>
          <Button
            variant="submit"
            onClick={handleSave}
            disabled={
              updatePermissionsMutation.isLoading ||
              !submitButtonActive ||
              (hasChanges && !hasAtLeastOneOwner)
            }
            className="w-full sm:w-auto"
            aria-label={localize('com_ui_save')}
            aria-describedby={hasChanges && !hasAtLeastOneOwner ? ownerErrorId : undefined}
          >
            {updatePermissionsMutation.isLoading ? (
              <div className="flex items-center gap-2">
                <Spinner className="size-4" />
                {localize('com_ui_saving')}
              </div>
            ) : (
              localize('com_ui_save')
            )}
          </Button>
        </OGDialogFooter>
      </OGDialogContent>
    </OGDialog>
  );
}
