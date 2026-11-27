import { useContext, useMemo } from 'react';
import { resolveErrorIdentity } from '@librechat/chat';
import { Permissions, SystemRoles, PermissionTypes } from 'librechat-data-provider';
import type { ErrorEnvironment, ErrorSource } from '@librechat/chat';
import type { AgentBuilderAccess } from '@librechat/chat/react';
import { useGetEndpointsQuery, useGetStartupConfig } from '~/data-provider';
import { useTranscriptAgentsMap } from '~/hooks/Agents/useTranscriptAgent';
import { useAgentsMapContext } from '~/Providers/AgentsMapContext';
import { ChatContext } from '~/Providers/ChatContext';
import { AuthContext } from '~/hooks/AuthContext';
import { useHasAccess } from '~/hooks';

/**
 * What this app knows about a failure beyond its row: the conversation, the transcript's agents,
 * the endpoint configuration and whether compaction is offered.
 *
 * Error content renders in the chat, in search results and in shared links. Only the chat surface
 * mounts `ChatContext`, and a shared link is read by a viewer whose query client is not
 * authenticated, so the endpoint queries stay disabled outside the chat rather than firing a
 * request that would resolve to a login redirect.
 */
export function useAppErrorEnvironment(source?: ErrorSource): ErrorEnvironment {
  const chat = useContext(ChatContext);
  const savedAgents = useAgentsMapContext();
  const inChat = chat != null;
  const { data: endpointsConfig } = useGetEndpointsQuery({ enabled: inChat });
  const { data: startupConfig } = useGetStartupConfig({ enabled: inChat });
  const conversation = chat?.conversation;
  const agentsMap = useTranscriptAgentsMap(resolveErrorIdentity(source, conversation).agentKey);
  const compactionEnabled =
    inChat &&
    startupConfig?.compactionEnabled === true &&
    startupConfig.interface?.contextUsage !== false;

  return useMemo(
    () => ({ conversation, agentsMap, savedAgents, endpointsConfig, compactionEnabled }),
    [conversation, agentsMap, savedAgents, endpointsConfig, compactionEnabled],
  );
}

/**
 * Whether the reader may open the agent builder: the side panel offers it only to a reader holding
 * both USE and CREATE on agents, and inside it an administrator may edit any agent.
 */
export function useAppAgentBuilderAccess(): AgentBuilderAccess {
  const role = useContext(AuthContext)?.user?.role;
  const canUse = useHasAccess({
    permissionType: PermissionTypes.AGENTS,
    permission: Permissions.USE,
  });
  const canCreate = useHasAccess({
    permissionType: PermissionTypes.AGENTS,
    permission: Permissions.CREATE,
  });
  const canUseBuilder = canUse && canCreate;
  const isAdmin = role === SystemRoles.ADMIN;
  return useMemo(() => ({ canUseBuilder, isAdmin }), [canUseBuilder, isAdmin]);
}
