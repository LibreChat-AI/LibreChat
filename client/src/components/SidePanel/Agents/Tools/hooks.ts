import { useMemo, useCallback } from 'react';
import { useQueries } from '@tanstack/react-query';
import { useToastContext } from '@librechat/client';
import { useFormContext, useWatch } from 'react-hook-form';
import { useUpdateUserPluginsMutation } from 'librechat-data-provider/react-query';
import {
  Tools,
  AuthType,
  QueryKeys,
  Permissions,
  dataService,
  PermissionTypes,
  AgentCapabilities,
} from 'librechat-data-provider';
import type { TSkillSummary } from 'librechat-data-provider';
import type { AgentForm, ExtendedFile } from '~/common';
import type { AgentItem } from './items/types';
import { useVerifyAgentToolAuth, useGetAgentFiles } from '~/data-provider';
import { useLocalize, useHasAccess, useHasMemoryAccess } from '~/hooks';
import { useFileMapContext, useAgentPanelContext } from '~/Providers';
import { deriveSelectedItems } from './items/selectors';
import { useAuthContext } from '~/hooks/AuthContext';
import { buildCatalog } from './items/catalog';
import { processAgentOption } from '~/utils';

/**
 * Maps builtin capability ids to whether they still need setup (USER_PROVIDED auth
 * not yet satisfied). Threaded into `buildCatalog` as `builtinAuthMap` so the
 * marketplace marks the capability `needs_setup` and routes its toggle to the
 * config dialog instead of silently enabling it without credentials. Only
 * `web_search` currently carries a user-provided key with an in-dialog entry point.
 *
 * While verification is still loading we don't yet know whether a user-provided
 * key is required, so `web_search` is treated as `needs_setup`: a click routes to
 * the config dialog rather than enabling it without the key on a slow connection.
 * Once the query resolves, only an unsatisfied user-provided key keeps the flag —
 * a system-defined deployment or a satisfied key clears it for a direct toggle.
 */
export function useBuiltinAuthMap(): Map<string, boolean> {
  const { data, isLoading } = useVerifyAgentToolAuth({ toolId: Tools.web_search }, { retry: 1 });
  return useMemo(() => {
    const map = new Map<string, boolean>();
    const isUserProvided =
      data?.authTypes?.some(([, authType]) => authType === AuthType.USER_PROVIDED) ?? false;
    if (isLoading || (isUserProvided && data?.authenticated !== true)) {
      map.set(AgentCapabilities.web_search, true);
    }
    return map;
  }, [data, isLoading]);
}

/**
 * Whether `web_search` uses USER_PROVIDED auth (a user-managed key). When false
 * the deployment uses SYSTEM_DEFINED keys, so there is nothing for the user to
 * configure. Shares the `useBuiltinAuthMap` React Query key, so it adds no
 * request. Threaded into `buildCatalog` so the card/row affordance is decided
 * synchronously (cog vs info) without a per-row hook.
 */
export function useWebSearchUserProvided(): boolean {
  const { data } = useVerifyAgentToolAuth({ toolId: Tools.web_search }, { retry: 1 });
  return useMemo(
    () => data?.authTypes?.some(([, authType]) => authType === AuthType.USER_PROVIDED) ?? false,
    [data],
  );
}

/**
 * Resolves whether the Memory capability should be offered in the builder.
 * Mirrors the legacy `AgentConfig` gate: the admin must enable the `memory`
 * capability, the user must hold the memory permission, and the user must not
 * have opted out of memories in personalization. Collapsed into one flag here
 * so both the selected list (`ToolsSection`) and the marketplace
 * (`ToolsMarketplaceDialog`) gate the catalog item identically.
 */
export function useShowMemory(): boolean {
  const { agentsConfig } = useAgentPanelContext();
  const hasMemoryAccess = useHasMemoryAccess();
  const { user } = useAuthContext();
  return useMemo(() => {
    const memoryEnabled = agentsConfig?.capabilities?.includes(AgentCapabilities.memory) ?? false;
    return hasMemoryAccess && memoryEnabled && user?.personalization?.memories !== false;
  }, [agentsConfig, hasMemoryAccess, user]);
}

export interface AgentFileEntries {
  contextFiles: Array<[string, ExtendedFile]>;
  knowledgeFiles: Array<[string, ExtendedFile]>;
  codeFiles: Array<[string, ExtendedFile]>;
}

const NO_FILES: Array<[string, ExtendedFile]> = [];

/**
 * File entries for the agent's builtin file tools (File Context, File Search,
 * Code Interpreter). Agents loaded from the API carry only
 * `tool_resources.*.file_ids` — the client-side entry arrays exist on the form
 * `agent` object only after an in-session upload. Reading them directly would
 * show an existing agent's attachments as empty, so this derives the missing
 * arrays by merging the agent files query into the file map, exactly like the
 * legacy `AgentConfig` hydration. Must be rendered inside the agent form's
 * `FormProvider` and the file map context.
 */
export function useAgentFileEntries(): AgentFileEntries {
  const { control } = useFormContext<AgentForm>();
  const agent = useWatch({ control, name: 'agent' });
  const agentId = useWatch({ control, name: 'id' });
  const fileMap = useFileMapContext();
  const { data: agentFiles = [] } = useGetAgentFiles(agentId);

  return useMemo(() => {
    if (agent == null || agent.id !== agentId) {
      return { contextFiles: NO_FILES, knowledgeFiles: NO_FILES, codeFiles: NO_FILES };
    }
    const needsHydration =
      agent.context_files == null || agent.knowledge_files == null || agent.code_files == null;
    let processed: ReturnType<typeof processAgentOption> | null = null;
    if (needsHydration) {
      const mergedFileMap = { ...fileMap };
      for (const file of agentFiles) {
        if (file.file_id) {
          mergedFileMap[file.file_id] = file;
        }
      }
      processed = processAgentOption({ agent, fileMap: mergedFileMap });
    }
    return {
      contextFiles: agent.context_files ?? processed?.context_files ?? NO_FILES,
      knowledgeFiles: agent.knowledge_files ?? processed?.knowledge_files ?? NO_FILES,
      codeFiles: agent.code_files ?? processed?.code_files ?? NO_FILES,
    };
  }, [agent, agentId, fileMap, agentFiles]);
}

interface UseAgentItemsOptions {
  agentId: string;
  /** Skills to include in the catalog; omit to exclude the skill kind entirely. */
  skills?: TSkillSummary[];
  skillsPermission?: boolean;
}

export interface AgentItemsResult {
  catalog: AgentItem[];
  selected: AgentItem[];
  tools: string[];
}

const NO_SKILLS: TSkillSummary[] = [];

/**
 * Single catalog + selection pipeline over the agent form, shared by the
 * selected list (`ToolsSection`) and the marketplace (`ToolsMarketplaceDialog`)
 * so the two can never diverge on gating or selection semantics. Must be
 * rendered inside the agent form's `FormProvider` and `AgentPanelContext`.
 */
export function useAgentItems({
  agentId,
  skills = NO_SKILLS,
  skillsPermission = false,
}: UseAgentItemsOptions): AgentItemsResult {
  const { control } = useFormContext<AgentForm>();
  const { agentsConfig, regularTools, mcpServersMap, actions } = useAgentPanelContext();
  const hasMcpAccess = useHasAccess({
    permissionType: PermissionTypes.MCP_SERVERS,
    permission: Permissions.USE,
  });
  const hasWebSearchAccess = useHasAccess({
    permissionType: PermissionTypes.WEB_SEARCH,
    permission: Permissions.USE,
  });
  const hasRunCodeAccess = useHasAccess({
    permissionType: PermissionTypes.RUN_CODE,
    permission: Permissions.USE,
  });
  const hasFileSearchAccess = useHasAccess({
    permissionType: PermissionTypes.FILE_SEARCH,
    permission: Permissions.USE,
  });
  const showMemory = useShowMemory();
  const webSearchUserProvided = useWebSearchUserProvided();
  const builtinAuthMap = useBuiltinAuthMap();

  const toolsField = useWatch({ control, name: 'tools' });
  const skillsWatch = useWatch({ control, name: 'skills' });
  const tools = useMemo(() => (toolsField ?? []) as string[], [toolsField]);
  const skillsField = useMemo(() => (skillsWatch ?? []) as string[], [skillsWatch]);
  const executeCode = (useWatch({ control, name: 'execute_code' }) ?? false) as boolean;
  const webSearch = (useWatch({ control, name: 'web_search' }) ?? false) as boolean;
  const fileSearch = (useWatch({ control, name: 'file_search' }) ?? false) as boolean;
  const memory = (useWatch({ control, name: 'memory' }) ?? false) as boolean;
  const artifacts = (useWatch({ control, name: 'artifacts' }) ?? '') as string;
  const { contextFiles, knowledgeFiles, codeFiles } = useAgentFileEntries();

  const agentActions = useMemo(
    () => (actions ?? []).filter((a) => a.agent_id === agentId),
    [actions, agentId],
  );

  const catalog = useMemo(
    () =>
      buildCatalog({
        agentsConfig: { capabilities: agentsConfig?.capabilities ?? [] },
        regularTools: regularTools ?? [],
        mcpServersMap: mcpServersMap ?? new Map(),
        skills,
        actions: agentActions,
        permissions: {
          mcp: hasMcpAccess,
          skills: skillsPermission,
          webSearch: hasWebSearchAccess,
          runCode: hasRunCodeAccess,
          fileSearch: hasFileSearchAccess,
        },
        showMemory,
        webSearchUserProvided,
        builtinAuthMap,
      }),
    [
      agentsConfig,
      regularTools,
      mcpServersMap,
      skills,
      agentActions,
      hasMcpAccess,
      hasWebSearchAccess,
      hasRunCodeAccess,
      hasFileSearchAccess,
      skillsPermission,
      showMemory,
      webSearchUserProvided,
      builtinAuthMap,
    ],
  );

  const selected = useMemo(
    () =>
      deriveSelectedItems(
        {
          execute_code: executeCode,
          web_search: webSearch,
          file_search: fileSearch,
          memory,
          artifacts,
          tools,
          skills: skillsField,
          context_files: contextFiles,
          knowledge_files: knowledgeFiles,
          code_files: codeFiles,
        },
        catalog,
        agentActions,
      ),
    [
      executeCode,
      webSearch,
      fileSearch,
      memory,
      artifacts,
      tools,
      skillsField,
      contextFiles,
      knowledgeFiles,
      codeFiles,
      catalog,
      agentActions,
    ],
  );

  return { catalog, selected, tools };
}

/**
 * Resolves agent allowlist skill ids missing from the first catalog page
 * (`limit: 100`) individually — a cache miss alone must never drop a
 * configured skill from the selected list, where it could no longer be
 * inspected or removed. Any settled lookup failure (deleted, no longer
 * shared, or a transient error with no retry pending) keeps a placeholder
 * entry so the allowlist id stays visible and removable; only in-flight
 * lookups are briefly hidden. Must be rendered inside the agent form's
 * `FormProvider`.
 */
export function useResolvedSkills(
  pageSkills?: TSkillSummary[],
  /** Off and All never render allowlist rows, so resolving ids the first
   *  catalog page missed would be one `getSkill` request per retained id for
   *  a list nobody sees. Callers pass `false` outside Selected. */
  resolveAllowlist = true,
): TSkillSummary[] | undefined {
  const localize = useLocalize();
  const { control } = useFormContext<AgentForm>();
  const skillsWatch = useWatch({ control, name: 'skills' });
  const unresolvedIds = useMemo(() => {
    if (pageSkills === undefined || !resolveAllowlist) {
      return [];
    }
    const known = new Set(pageSkills.map((skill) => skill._id));
    return ((skillsWatch ?? []) as string[]).filter((id) => !known.has(id));
  }, [pageSkills, skillsWatch, resolveAllowlist]);

  const lookups = useQueries({
    queries: unresolvedIds.map((skillId) => ({
      queryKey: [QueryKeys.skill, skillId],
      queryFn: () => dataService.getSkill(skillId),
      retry: false,
      refetchOnMount: false,
      refetchOnReconnect: false,
      refetchOnWindowFocus: false,
    })),
  });

  return useMemo(() => {
    if (pageSkills === undefined) {
      return undefined;
    }
    if (unresolvedIds.length === 0) {
      return pageSkills;
    }
    const extras: TSkillSummary[] = [];
    for (let i = 0; i < unresolvedIds.length; i++) {
      const lookup = lookups[i];
      if (lookup?.data != null) {
        extras.push(lookup.data);
        continue;
      }
      if (lookup?.isError === true) {
        extras.push({
          _id: unresolvedIds[i],
          name: localize('com_ui_skill_unavailable'),
          description: '',
          author: '',
          authorName: '',
          version: 0,
          source: 'inline',
          fileCount: 0,
          createdAt: '',
          updatedAt: '',
        });
      }
    }
    return extras.length > 0 ? [...pageSkills, ...extras] : pageSkills;
  }, [pageSkills, unresolvedIds, lookups, localize]);
}

/**
 * Returns a callback that revokes a tool's stored user credentials when it is
 * removed from an agent, mirroring the legacy `AgentTool` removal. Without it,
 * removing a tool only drops it from the form and leaves the saved credentials
 * orphaned server-side. Fired unconditionally — a no-op for tools without creds.
 */
export function useUninstallToolCredentials(): (toolId: string) => void {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const updateUserPlugins = useUpdateUserPluginsMutation();
  return useCallback(
    (toolId: string) => {
      if (!toolId) {
        return;
      }
      updateUserPlugins.mutate(
        { pluginKey: toolId, action: 'uninstall', auth: {}, isEntityTool: true },
        {
          onError: () =>
            showToast({ message: localize('com_ui_delete_tool_error'), status: 'error' }),
        },
      );
    },
    [updateUserPlugins, showToast, localize],
  );
}
