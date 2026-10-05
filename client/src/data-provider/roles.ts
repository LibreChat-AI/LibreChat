import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  QueryKeys,
  dataService,
  promptPermissionsSchema,
  artifactPermissionsSchema,
  skillPermissionsSchema,
  memoryPermissionsSchema,
  mcpServersPermissionsSchema,
  marketplacePermissionsSchema,
  peoplePickerPermissionsSchema,
  remoteAgentsPermissionsSchema,
} from 'librechat-data-provider';
import type {
  QueryObserverResult,
  UseMutationResult,
  UseQueryOptions,
} from '@tanstack/react-query';
import type * as t from 'librechat-data-provider';

export const useGetRole = (
  roleName: string,
  config?: UseQueryOptions<t.TRole>,
): QueryObserverResult<t.TRole> => {
  return useQuery<t.TRole>([QueryKeys.roles, roleName], () => dataService.getRole(roleName), {
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
    retry: false,
    ...config,
  });
};

export const useListRoles = (
  config?: UseQueryOptions<t.ListRolesResponse>,
): QueryObserverResult<t.ListRolesResponse> => {
  return useQuery<t.ListRolesResponse>([QueryKeys.rolesList], () => dataService.listRoles(), {
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
    retry: false,
    ...config,
  });
};

export const useUpdatePromptPermissionsMutation = (
  options?: t.UpdatePromptPermOptions,
): UseMutationResult<
  t.UpdatePermResponse,
  t.TError | undefined,
  t.UpdatePromptPermVars,
  unknown
> => {
  const queryClient = useQueryClient();
  const { onMutate, onSuccess, onError } = options ?? {};
  return useMutation(
    (variables) => {
      promptPermissionsSchema.partial().parse(variables.updates);
      return dataService.updatePromptPermissions(variables);
    },
    {
      onSuccess: (data, variables, context) => {
        queryClient.invalidateQueries([QueryKeys.roles, variables.roleName]);
        if (onSuccess) {
          onSuccess(data, variables, context);
        }
      },
      onError: (...args) => {
        const error = args[0];
        if (error != null) {
          console.error('Failed to update prompt permissions:', error);
        }
        if (onError) {
          onError(...args);
        }
      },
      onMutate,
    },
  );
};

export const useUpdateAgentPermissionsMutation = (
  options?: t.UpdateAgentPermOptions,
): UseMutationResult<
  t.UpdatePermResponse,
  t.TError | undefined,
  t.UpdateAgentPermVars,
  unknown
> => {
  const queryClient = useQueryClient();
  const { onMutate, onSuccess, onError } = options ?? {};
  return useMutation(
    (variables) => {
      promptPermissionsSchema.partial().parse(variables.updates);
      return dataService.updateAgentPermissions(variables);
    },
    {
      onSuccess: (data, variables, context) => {
        queryClient.invalidateQueries([QueryKeys.roles, variables.roleName]);
        if (onSuccess != null) {
          onSuccess(data, variables, context);
        }
      },
      onError: (...args) => {
        const error = args[0];
        if (error != null) {
          console.error('Failed to update prompt permissions:', error);
        }
        if (onError != null) {
          onError(...args);
        }
      },
      onMutate,
    },
  );
};

export const useUpdateArtifactPermissionsMutation = (
  options?: t.UpdateArtifactPermOptions,
): UseMutationResult<
  t.UpdatePermResponse,
  t.TError | undefined,
  t.UpdateArtifactPermVars,
  unknown
> => {
  const queryClient = useQueryClient();
  const { onMutate, onSuccess, onError } = options ?? {};
  return useMutation(
    (variables) => {
      artifactPermissionsSchema.partial().parse(variables.updates);
      return dataService.updateArtifactPermissions(variables);
    },
    {
      onSuccess: (data, variables, context) => {
        queryClient.invalidateQueries([QueryKeys.roles, variables.roleName]);
        onSuccess?.(data, variables, context);
      },
      onError: (...args) => {
        if (args[0] != null) {
          console.error('Failed to update artifact permissions:', args[0]);
        }
        onError?.(...args);
      },
      onMutate,
    },
  );
};

export const useUpdateSkillPermissionsMutation = (
  options?: t.UpdateSkillPermOptions,
): UseMutationResult<
  t.UpdatePermResponse,
  t.TError | undefined,
  t.UpdateSkillPermVars,
  unknown
> => {
  const queryClient = useQueryClient();
  const { onMutate, onSuccess, onError } = options ?? {};
  return useMutation(
    (variables) => {
      skillPermissionsSchema.partial().parse(variables.updates);
      return dataService.updateSkillPermissions(variables);
    },
    {
      onSuccess: (data, variables, context) => {
        queryClient.invalidateQueries([QueryKeys.roles, variables.roleName]);
        if (onSuccess) {
          onSuccess(data, variables, context);
        }
      },
      onError: (...args) => {
        const error = args[0];
        if (error != null) {
          console.error('Failed to update skill permissions:', error);
        }
        if (onError) {
          onError(...args);
        }
      },
      onMutate,
    },
  );
};

export const useUpdateMemoryPermissionsMutation = (
  options?: t.UpdateMemoryPermOptions,
): UseMutationResult<
  t.UpdatePermResponse,
  t.TError | undefined,
  t.UpdateMemoryPermVars,
  unknown
> => {
  const queryClient = useQueryClient();
  const { onMutate, onSuccess, onError } = options ?? {};
  return useMutation(
    (variables) => {
      memoryPermissionsSchema.partial().parse(variables.updates);
      return dataService.updateMemoryPermissions(variables);
    },
    {
      onSuccess: (data, variables, context) => {
        queryClient.invalidateQueries([QueryKeys.roles, variables.roleName]);
        if (onSuccess) {
          onSuccess(data, variables, context);
        }
      },
      onError: (...args) => {
        const error = args[0];
        if (error != null) {
          console.error('Failed to update memory permissions:', error);
        }
        if (onError) {
          onError(...args);
        }
      },
      onMutate,
    },
  );
};

export const useUpdatePeoplePickerPermissionsMutation = (
  options?: t.UpdatePeoplePickerPermOptions,
): UseMutationResult<
  t.UpdatePermResponse,
  t.TError | undefined,
  t.UpdatePeoplePickerPermVars,
  unknown
> => {
  const queryClient = useQueryClient();
  const { onMutate, onSuccess, onError } = options ?? {};
  return useMutation(
    (variables) => {
      peoplePickerPermissionsSchema.partial().parse(variables.updates);
      return dataService.updatePeoplePickerPermissions(variables);
    },
    {
      onSuccess: (data, variables, context) => {
        queryClient.invalidateQueries([QueryKeys.roles, variables.roleName]);
        if (onSuccess) {
          onSuccess(data, variables, context);
        }
      },
      onError: (...args) => {
        const error = args[0];
        if (error != null) {
          console.error('Failed to update people picker permissions:', error);
        }
        if (onError) {
          onError(...args);
        }
      },
      onMutate,
    },
  );
};

export const useUpdateMCPServersPermissionsMutation = (
  options?: t.UpdateMCPServersPermOptions,
): UseMutationResult<
  t.UpdatePermResponse,
  t.TError | undefined,
  t.UpdateMCPServersPermVars,
  unknown
> => {
  const queryClient = useQueryClient();
  const { onMutate, onSuccess, onError } = options ?? {};
  return useMutation(
    (variables) => {
      mcpServersPermissionsSchema.partial().parse(variables.updates);
      return dataService.updateMCPServersPermissions(variables);
    },
    {
      onSuccess: (data, variables, context) => {
        queryClient.invalidateQueries([QueryKeys.roles, variables.roleName]);
        if (onSuccess) {
          onSuccess(data, variables, context);
        }
      },
      onError: (...args) => {
        const error = args[0];
        if (error != null) {
          console.error('Failed to update MCP servers permissions:', error);
        }
        if (onError) {
          onError(...args);
        }
      },
      onMutate,
    },
  );
};

export const useUpdateMarketplacePermissionsMutation = (
  options?: t.UpdateMarketplacePermOptions,
): UseMutationResult<
  t.UpdatePermResponse,
  t.TError | undefined,
  t.UpdateMarketplacePermVars,
  unknown
> => {
  const queryClient = useQueryClient();
  const { onMutate, onSuccess, onError } = options ?? {};
  return useMutation(
    (variables) => {
      marketplacePermissionsSchema.partial().parse(variables.updates);
      return dataService.updateMarketplacePermissions(variables);
    },
    {
      onSuccess: (data, variables, context) => {
        queryClient.invalidateQueries([QueryKeys.roles, variables.roleName]);
        if (onSuccess) {
          onSuccess(data, variables, context);
        }
      },
      onError: (...args) => {
        const error = args[0];
        if (error != null) {
          console.error('Failed to update marketplace permissions:', error);
        }
        if (onError) {
          onError(...args);
        }
      },
      onMutate,
    },
  );
};

export const useUpdateRemoteAgentsPermissionsMutation = (
  options?: t.UpdateRemoteAgentsPermOptions,
): UseMutationResult<
  t.UpdatePermResponse,
  t.TError | undefined,
  t.UpdateRemoteAgentsPermVars,
  unknown
> => {
  const queryClient = useQueryClient();
  const { onMutate, onSuccess, onError } = options ?? {};
  return useMutation(
    (variables) => {
      remoteAgentsPermissionsSchema.partial().parse(variables.updates);
      return dataService.updateRemoteAgentsPermissions(variables);
    },
    {
      onSuccess: (data, variables, context) => {
        queryClient.invalidateQueries([QueryKeys.roles, variables.roleName]);
        if (onSuccess) {
          onSuccess(data, variables, context);
        }
      },
      onError: (...args) => {
        const error = args[0];
        if (error != null) {
          console.error('Failed to update remote agents permissions:', error);
        }
        if (onError) {
          onError(...args);
        }
      },
      onMutate,
    },
  );
};
