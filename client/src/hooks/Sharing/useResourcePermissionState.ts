import { useState, useEffect } from 'react';
import {
  useGetResourcePermissionsQuery,
  useUpdateResourcePermissionsMutation,
} from 'librechat-data-provider/react-query';
import type { TPrincipal, ResourceType, AccessRoleIds } from 'librechat-data-provider';
import { getResourceConfig } from '~/utils';

/**
 * Hook to manage resource permission state including current shares, public access, and mutations
 * @param resourceType - Type of resource (e.g., ResourceType.AGENT, ResourceType.PROMPTGROUP, ResourceType.MCPSERVER)
 * @param resourceDbId - Database ID of the resource
 * @param isModalOpen - Whether the modal is open (for effect dependencies)
 * @returns Object with permission state and update mutation
 */
export const useResourcePermissionState = (
  resourceType: ResourceType,
  resourceDbId: string | null | undefined,
  isModalOpen: boolean = false,
) => {
  const config = getResourceConfig(resourceType);

  // Only enable the query if we have a valid resourceDbId
  const isValidResourceId = !!resourceDbId && resourceDbId.trim() !== '';

  const {
    data: permissionsData,
    isLoading: isLoadingPermissions,
    isFetching: isFetchingPermissions,
    error: permissionsError,
    refetch: refetchPermissions,
  } = useGetResourcePermissionsQuery(resourceType, resourceDbId || '', {
    enabled: isValidResourceId,
  });

  const updatePermissionsMutation = useUpdateResourcePermissionsMutation();

  // Extract current shares from permissions data
  const currentShares: TPrincipal[] =
    permissionsData?.principals?.map((principal) => ({
      type: principal.type,
      id: principal.id,
      name: principal.name,
      email: principal.email,
      source: principal.source,
      avatar: principal.avatar,
      description: principal.description,
      accessRoleId: principal.accessRoleId,
      idOnTheSource: principal.idOnTheSource,
      viewInsights: principal.viewInsights,
    })) || [];

  const currentIsPublic = permissionsData?.public ?? false;
  const currentPublicRole = permissionsData?.publicAccessRoleId || config?.defaultViewerRoleId;

  // State for managing public access
  const [isPublic, setIsPublic] = useState(false);
  const [publicRole, setPublicRole] = useState<AccessRoleIds | undefined>(
    config?.defaultViewerRoleId,
  );

  // Sync state with permissions data when modal opens
  useEffect(() => {
    if (permissionsData && isModalOpen) {
      setIsPublic(currentIsPublic ?? false);
      setPublicRole(currentPublicRole);
    }
  }, [permissionsData, isModalOpen, currentIsPublic, currentPublicRole]);

  return {
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
  };
};
