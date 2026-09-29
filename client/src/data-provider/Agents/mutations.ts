import { useMutation, useQueryClient } from '@tanstack/react-query';
import { dataService, MutationKeys, PermissionBits, QueryKeys } from 'librechat-data-provider';
import type { QueryClient, UseMutationResult } from '@tanstack/react-query';
import type * as t from 'librechat-data-provider';

/**
 * AGENTS
 */
export const allAgentViewAndEditQueryKeys: t.AgentListParams[] = [
  { requiredPermission: PermissionBits.VIEW },
  { requiredPermission: PermissionBits.EDIT },
];

const edgeEndpointIncludesAgent = (endpoint: string | string[], agentId: string): boolean =>
  Array.isArray(endpoint) ? endpoint.includes(agentId) : endpoint === agentId;

const hasEdgeWithAgent = (data: unknown, agentId: string): boolean => {
  if (!data || typeof data !== 'object') {
    return false;
  }

  const { edges } = data as Partial<t.Agent>;
  return (
    Array.isArray(edges) &&
    edges.some(
      (edge) =>
        edgeEndpointIncludesAgent(edge.from, agentId) ||
        edgeEndpointIncludesAgent(edge.to, agentId),
    )
  );
};

const pruneEdgeEndpoint = (
  endpoint: t.GraphEdge['from'],
  agentId: string,
): t.GraphEdge['from'] | null => {
  if (Array.isArray(endpoint)) {
    const retained = endpoint.filter((id) => id !== agentId);
    return retained.length > 0 ? retained : null;
  }
  return endpoint === agentId ? null : endpoint;
};

/** Mirrors the server's deletion cleanup so cached execution graphs stop referencing the
 * deleted agent immediately, before the authoritative refetch completes. */
const pruneAgentEdges = (agent: t.Agent, agentId: string): t.Agent => {
  if (!hasEdgeWithAgent(agent, agentId)) {
    return agent;
  }
  const edges = (agent.edges ?? []).flatMap((edge) => {
    const from = pruneEdgeEndpoint(edge.from, agentId);
    const to = pruneEdgeEndpoint(edge.to, agentId);
    return from == null || to == null ? [] : [{ ...edge, from, to }];
  });
  return { ...agent, edges };
};

/**
 * Mutation responses omit list-only `isEditable`. When merging into a cached list
 * row, keep the ACL flag the list endpoint set rather than inferring it from
 * write success (`MANAGE_AGENTS` can PATCH agents the ACL marks non-editable).
 */
const mergeAgentListRow = (previous: t.Agent, next: t.Agent): t.Agent => {
  if (previous.isEditable === undefined) {
    return next;
  }
  return { ...next, isEditable: previous.isEditable };
};

/**
 * Create a new agent
 */
export const useCreateAgentMutation = (
  options?: t.CreateAgentMutationOptions,
): UseMutationResult<t.Agent, Error, t.AgentCreateParams> => {
  const queryClient = useQueryClient();
  return useMutation((newAgentData: t.AgentCreateParams) => dataService.createAgent(newAgentData), {
    onMutate: (variables) => options?.onMutate?.(variables),
    onError: (error, variables, context) => options?.onError?.(error, variables, context),
    onSuccess: (newAgent, variables, context) => {
      ((keys: t.AgentListParams[]) => {
        keys.forEach((key) => {
          const listRes = queryClient.getQueryData<t.AgentListResponse>([QueryKeys.agents, key]);
          if (!listRes) {
            return options?.onSuccess?.(newAgent, variables, context);
          }
          /** The create succeeded, so the caller can edit it. Mutation responses carry no
           *  `isEditable`; without this the cached row loses the field the list sets. */
          const currentAgents = [
            { ...newAgent, isEditable: true },
            ...JSON.parse(JSON.stringify(listRes.data)),
          ];

          queryClient.setQueryData<t.AgentListResponse>([QueryKeys.agents, key], {
            ...listRes,
            data: currentAgents,
          });
        });
      })(allAgentViewAndEditQueryKeys);
      invalidateAgentMarketplaceQueries(queryClient);

      return options?.onSuccess?.(newAgent, variables, context);
    },
  });
};

/**
 * Hook for updating an agent
 */
export const useUpdateAgentMutation = (
  options?: t.UpdateAgentMutationOptions,
): UseMutationResult<t.Agent, Error, { agent_id: string; data: t.AgentUpdateParams }> => {
  const queryClient = useQueryClient();
  return useMutation(
    ({ agent_id, data }: { agent_id: string; data: t.AgentUpdateParams }) => {
      return dataService.updateAgent({
        data,
        agent_id,
      });
    },
    {
      onMutate: (variables) => options?.onMutate?.(variables),
      onError: (error, variables, context) => {
        return options?.onError?.(error, variables, context);
      },
      onSuccess: (updatedAgent, variables, context) => {
        ((keys: t.AgentListParams[]) => {
          keys.forEach((key) => {
            const listRes = queryClient.getQueryData<t.AgentListResponse>([QueryKeys.agents, key]);

            if (!listRes) {
              return options?.onSuccess?.(updatedAgent, variables, context);
            }

            queryClient.setQueryData<t.AgentListResponse>([QueryKeys.agents, key], {
              ...listRes,
              data: listRes.data.map((agent) => {
                if (agent.id === variables.agent_id) {
                  return mergeAgentListRow(agent, updatedAgent);
                }
                return agent;
              }),
            });
          });
        })(allAgentViewAndEditQueryKeys);

        queryClient.setQueryData<t.Agent>([QueryKeys.agent, variables.agent_id], updatedAgent);
        queryClient.setQueryData<t.Agent>(
          [QueryKeys.agent, variables.agent_id, 'expanded'],
          updatedAgent,
        );
        invalidateAgentMarketplaceQueries(queryClient);

        return options?.onSuccess?.(updatedAgent, variables, context);
      },
    },
  );
};

/**
 * Hook for deleting an agent
 */
export const useDeleteAgentMutation = (
  options?: t.DeleteAgentMutationOptions,
): UseMutationResult<void, Error, t.DeleteAgentBody> => {
  const queryClient = useQueryClient();
  return useMutation(
    ({ agent_id }: t.DeleteAgentBody) => {
      return dataService.deleteAgent({ agent_id });
    },
    {
      onMutate: (variables) => options?.onMutate?.(variables),
      onError: (error, variables, context) => options?.onError?.(error, variables, context),
      onSuccess: (_data, variables, context) => {
        const data = ((keys: t.AgentListParams[]) => {
          let data: t.Agent[] = [];
          keys.forEach((key) => {
            const listRes = queryClient.getQueryData<t.AgentListResponse>([QueryKeys.agents, key]);

            if (!listRes) {
              return options?.onSuccess?.(_data, variables, context);
            }

            data = listRes.data
              .filter((agent) => agent.id !== variables.agent_id)
              .map((agent) => pruneAgentEdges(agent, variables.agent_id));

            queryClient.setQueryData<t.AgentListResponse>([QueryKeys.agents, key], {
              ...listRes,
              data,
            });
          });
          return data;
        })(allAgentViewAndEditQueryKeys);

        queryClient.removeQueries([QueryKeys.agent, variables.agent_id]);
        queryClient.removeQueries([QueryKeys.agent, variables.agent_id, 'expanded']);
        /** Deletion removes the agent from every edge endpoint server-side. Refresh every cached
         * graph known to reference it, then mirror that cleanup immediately while refetch runs. */
        queryClient.invalidateQueries({
          queryKey: [QueryKeys.agent],
          predicate: (query) => hasEdgeWithAgent(query.state.data, variables.agent_id),
          refetchType: 'all',
        });
        queryClient.setQueriesData<t.Agent>(
          {
            queryKey: [QueryKeys.agent],
            predicate: (query) => hasEdgeWithAgent(query.state.data, variables.agent_id),
          },
          (agent) => (agent ? pruneAgentEdges(agent, variables.agent_id) : agent),
        );
        invalidateAgentMarketplaceQueries(queryClient);

        return options?.onSuccess?.(_data, variables, data);
      },
    },
  );
};

/**
 * Hook for duplicating an agent
 */
export const useDuplicateAgentMutation = (
  options?: t.DuplicateAgentMutationOptions,
): UseMutationResult<{ agent: t.Agent; actions: t.Action[] }, Error, t.DuplicateAgentBody> => {
  const queryClient = useQueryClient();

  return useMutation<{ agent: t.Agent; actions: t.Action[] }, Error, t.DuplicateAgentBody>(
    (params: t.DuplicateAgentBody) => dataService.duplicateAgent(params),
    {
      onMutate: options?.onMutate,
      onError: options?.onError,
      onSuccess: ({ agent, actions }, variables, context) => {
        ((keys: t.AgentListParams[]) => {
          keys.forEach((key) => {
            const listRes = queryClient.getQueryData<t.AgentListResponse>([QueryKeys.agents, key]);
            if (listRes) {
              /** Duplicating grants the caller ownership, so the new row is editable.
               *  The response omits list-only `isEditable`; see `mergeAgentListRow`. */
              const currentAgents = [{ ...agent, isEditable: true }, ...listRes.data];
              queryClient.setQueryData<t.AgentListResponse>([QueryKeys.agents, key], {
                ...listRes,
                data: currentAgents,
              });
            }
          });
        })(allAgentViewAndEditQueryKeys);

        const existingActions = queryClient.getQueryData<t.Action[]>([QueryKeys.actions]) || [];

        queryClient.setQueryData<t.Action[]>([QueryKeys.actions], existingActions.concat(actions));
        invalidateAgentMarketplaceQueries(queryClient);

        return options?.onSuccess?.({ agent, actions }, variables, context);
      },
    },
  );
};

/**
 * Hook for uploading an agent avatar
 */
export const useUploadAgentAvatarMutation = (
  options?: t.UploadAgentAvatarOptions,
): UseMutationResult<
  t.Agent, // response data
  unknown, // error
  t.AgentAvatarVariables, // request
  unknown // context
> => {
  const queryClient = useQueryClient();
  return useMutation<t.Agent, unknown, t.AgentAvatarVariables>({
    mutationKey: [MutationKeys.agentAvatarUpload],
    mutationFn: (variables: t.AgentAvatarVariables) => dataService.uploadAgentAvatar(variables),
    onMutate: (variables) => options?.onMutate?.(variables),
    onError: (error, variables, context) => options?.onError?.(error, variables, context),
    onSuccess: (updatedAgent, variables, context) => {
      ((keys: t.AgentListParams[]) => {
        keys.forEach((key) => {
          const listRes = queryClient.getQueryData<t.AgentListResponse>([QueryKeys.agents, key]);
          if (!listRes) {
            return;
          }

          queryClient.setQueryData<t.AgentListResponse>([QueryKeys.agents, key], {
            ...listRes,
            data: listRes.data.map((agent) => {
              if (agent.id === variables.agent_id) {
                return mergeAgentListRow(agent, updatedAgent);
              }
              return agent;
            }),
          });
        });
      })(allAgentViewAndEditQueryKeys);

      queryClient.setQueryData<t.Agent>([QueryKeys.agent, variables.agent_id], updatedAgent);
      queryClient.setQueryData<t.Agent>(
        [QueryKeys.agent, variables.agent_id, 'expanded'],
        updatedAgent,
      );
      invalidateAgentMarketplaceQueries(queryClient);

      return options?.onSuccess?.(updatedAgent, variables, context);
    },
  });
};

/**
 * Hook for updating Agent Actions
 */
export const useUpdateAgentAction = (
  options?: t.UpdateAgentActionOptions,
): UseMutationResult<
  t.UpdateAgentActionResponse, // response data
  unknown, // error
  t.UpdateAgentActionVariables, // request
  unknown // context
> => {
  const queryClient = useQueryClient();
  return useMutation([MutationKeys.updateAgentAction], {
    mutationFn: (variables: t.UpdateAgentActionVariables) =>
      dataService.updateAgentAction(variables),

    onMutate: (variables) => options?.onMutate?.(variables),
    onError: (error, variables, context) => options?.onError?.(error, variables, context),
    onSuccess: (updateAgentActionResponse, variables, context) => {
      const updatedAgent = updateAgentActionResponse[0];
      ((keys: t.AgentListParams[]) => {
        keys.forEach((key) => {
          const listRes = queryClient.getQueryData<t.AgentListResponse>([QueryKeys.agents, key]);

          if (!listRes) {
            return options?.onSuccess?.(updateAgentActionResponse, variables, context);
          }
          queryClient.setQueryData<t.AgentListResponse>([QueryKeys.agents, key], {
            ...listRes,
            data: listRes.data.map((agent) => {
              if (agent.id === variables.agent_id) {
                return mergeAgentListRow(agent, updatedAgent);
              }
              return agent;
            }),
          });
        });
      })(allAgentViewAndEditQueryKeys);

      queryClient.setQueryData<t.Action[]>([QueryKeys.actions], (prev) => {
        if (!prev) {
          return [updateAgentActionResponse[1]];
        }

        if (variables.action_id) {
          return prev.map((action) => {
            if (action.action_id === variables.action_id) {
              return updateAgentActionResponse[1];
            }
            return action;
          });
        }

        return [...prev, updateAgentActionResponse[1]];
      });

      queryClient.setQueryData<t.Agent>([QueryKeys.agent, variables.agent_id], updatedAgent);
      queryClient.setQueryData<t.Agent>(
        [QueryKeys.agent, variables.agent_id, 'expanded'],
        updatedAgent,
      );
      return options?.onSuccess?.(updateAgentActionResponse, variables, context);
    },
  });
};

/**
 * Hook for deleting an Agent Action
 */

export const useDeleteAgentAction = (
  options?: t.DeleteAgentActionOptions,
): UseMutationResult<void, Error, t.DeleteAgentActionVariables, unknown> => {
  const queryClient = useQueryClient();
  return useMutation([MutationKeys.deleteAgentAction], {
    mutationFn: (variables: t.DeleteAgentActionVariables) => {
      return dataService.deleteAgentAction({
        ...variables,
      });
    },

    onMutate: (variables) => options?.onMutate?.(variables),
    onError: (error, variables, context) => options?.onError?.(error, variables, context),
    onSuccess: (_data, variables, context) => {
      let domain: string | undefined = '';
      queryClient.setQueryData<t.Action[]>([QueryKeys.actions], (prev) => {
        return prev?.filter((action) => {
          domain = action.metadata.domain;
          return action.action_id !== variables.action_id;
        });
      });
      ((keys: t.AgentListParams[]) => {
        keys.forEach((key) => {
          queryClient.setQueryData<t.AgentListResponse>([QueryKeys.agents, key], (prev) => {
            if (!prev) {
              return prev;
            }

            return {
              ...prev,
              data: prev.data.map((agent) => {
                if (agent.id === variables.agent_id) {
                  return {
                    ...agent,
                    tools: agent.tools?.filter((tool) => !tool.includes(domain ?? '')),
                  };
                }
                return agent;
              }),
            };
          });
        });
      })(allAgentViewAndEditQueryKeys);
      const updaterFn = (prev) => {
        if (!prev) {
          return prev;
        }

        return {
          ...prev,
          tools: prev.tools?.filter((tool) => !tool.includes(domain ?? '')),
        };
      };
      queryClient.setQueryData<t.Agent>([QueryKeys.agent, variables.agent_id], updaterFn);
      queryClient.setQueryData<t.Agent>(
        [QueryKeys.agent, variables.agent_id, 'expanded'],
        updaterFn,
      );
      return options?.onSuccess?.(_data, variables, context);
    },
  });
};

/**
 * Hook for reverting an agent to a previous version
 */
export const useRevertAgentVersionMutation = (
  options?: t.RevertAgentVersionOptions,
): UseMutationResult<t.Agent, Error, { agent_id: string; version_index: number }> => {
  const queryClient = useQueryClient();
  return useMutation(
    ({ agent_id, version_index }: { agent_id: string; version_index: number }) => {
      return dataService.revertAgentVersion({
        agent_id,
        version_index,
      });
    },
    {
      onMutate: (variables) => options?.onMutate?.(variables),
      onError: (error, variables, context) => options?.onError?.(error, variables, context),
      onSuccess: (revertedAgent, variables, context) => {
        queryClient.setQueryData<t.Agent>([QueryKeys.agent, variables.agent_id], revertedAgent);
        queryClient.setQueryData<t.Agent>(
          [QueryKeys.agent, variables.agent_id, 'expanded'],
          revertedAgent,
        );
        queryClient.invalidateQueries([QueryKeys.agent, variables.agent_id, 'versions']);

        ((keys: t.AgentListParams[]) => {
          keys.forEach((key) => {
            const listRes = queryClient.getQueryData<t.AgentListResponse>([QueryKeys.agents, key]);

            if (listRes) {
              queryClient.setQueryData<t.AgentListResponse>([QueryKeys.agents, key], {
                ...listRes,
                data: listRes.data.map((agent) => {
                  if (agent.id === variables.agent_id) {
                    return mergeAgentListRow(agent, revertedAgent);
                  }
                  return agent;
                }),
              });
            }
          });
        })(allAgentViewAndEditQueryKeys);

        return options?.onSuccess?.(revertedAgent, variables, context);
      },
    },
  );
};

export const invalidateAgentMarketplaceQueries = (queryClient: QueryClient) => {
  queryClient.invalidateQueries([QueryKeys.marketplaceAgents]);
};
