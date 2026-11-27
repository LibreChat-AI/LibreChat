import { logger } from '@librechat/data-schemas';
import { Constants, Tools } from 'librechat-data-provider';
import type { Agent } from 'librechat-data-provider';
import type { Types } from 'mongoose';
import type {
  ResolveAlwaysApplySkillsParams,
  ResolvedAlwaysApplySkill,
  ResolvedSkillCatalog,
  TListSkillsByAccess,
} from './skills';
import {
  resolveAgentScopedSkillIds,
  resolveAlwaysApplySkills,
  resolveSkillCatalog,
} from './skills';
import { buildHistoricalToolNames } from './tools';

type LazyHistoryAgent = Pick<Agent, 'id' | 'skills' | 'skills_enabled' | 'tools' | 'tool_options'>;

export interface LazyAgentHistoryCapabilities {
  deferredToolsAvailable: boolean;
  programmaticToolsAvailable: boolean;
  backgroundToolsAvailable: boolean;
}

export interface CreateLazyAgentHistoryResolverParams extends LazyAgentHistoryCapabilities {
  accessibleSkillIds: Types.ObjectId[];
  editableSkillIds: Types.ObjectId[];
  skillsCapabilityEnabled: boolean;
  ephemeralSkillsToggle: boolean;
  userId?: string;
  userRole?: string;
  skillStates?: Record<string, boolean>;
  defaultActiveOnShare?: boolean;
  maxCatalogSkills?: number;
  listSkillsByAccess?: TListSkillsByAccess;
  listAlwaysApplySkills?: ResolveAlwaysApplySkillsParams['listAlwaysApplySkills'];
  getAccessibleMcpServerNames?: (userId?: string, role?: string) => Promise<string[]>;
  configuredMcpServerNames?: readonly string[];
  canAuthorSkillFiles?: (params: {
    agent: LazyHistoryAgent;
    scopedEditableSkillIds: Types.ObjectId[];
  }) => boolean;
}

export interface LazyAgentHistoryMetadata {
  alwaysApplySkillPrimes: ResolvedAlwaysApplySkill[];
  historicalToolNames: string[];
  historicalMcpServerNames: string[];
  skillAuthoringAvailable: boolean;
}

export interface LazyAgentHistoryResolver {
  resolve(params: {
    agent: LazyHistoryAgent;
    codeExecutionAvailable: boolean;
    memoryAvailable: boolean;
  }): Promise<LazyAgentHistoryMetadata>;
}

function skillScopeKey(ids: readonly Types.ObjectId[]): string {
  return ids
    .map((skillId) => skillId.toString())
    .sort()
    .join(':');
}

/**
 * Creates one request-scoped lazy-history policy resolver.
 *
 * The resolver owns Skill activation/catalog policy, per-scope query caching,
 * MCP name auditing, and capability-to-tool expansion so the legacy host only
 * wires request dependencies and consumes typed metadata.
 */
export function createLazyAgentHistoryResolver(
  params: CreateLazyAgentHistoryResolverParams,
): LazyAgentHistoryResolver {
  const alwaysApplyByScope = new Map<string, Promise<ResolvedAlwaysApplySkill[]>>();
  const catalogByScope = new Map<string, Promise<ResolvedSkillCatalog>>();
  let mcpServerNames: Promise<string[]> | undefined;

  const resolveAlwaysApply = (scopedSkillIds: Types.ObjectId[]) => {
    if (scopedSkillIds.length === 0 || !params.listAlwaysApplySkills) {
      return Promise.resolve([]);
    }
    const key = skillScopeKey(scopedSkillIds);
    let resolution = alwaysApplyByScope.get(key);
    if (!resolution) {
      resolution = resolveAlwaysApplySkills({
        listAlwaysApplySkills: params.listAlwaysApplySkills,
        accessibleSkillIds: scopedSkillIds,
        userId: params.userId,
        skillStates: params.skillStates,
        defaultActiveOnShare: params.defaultActiveOnShare,
      });
      alwaysApplyByScope.set(key, resolution);
    }
    return resolution;
  };

  const resolveCatalog = (scopedSkillIds: Types.ObjectId[]) => {
    const key = skillScopeKey(scopedSkillIds);
    let resolution = catalogByScope.get(key);
    if (!resolution) {
      resolution = resolveSkillCatalog({
        accessibleSkillIds: scopedSkillIds,
        listSkillsByAccess: params.listSkillsByAccess,
        userId: params.userId,
        skillStates: params.skillStates,
        defaultActiveOnShare: params.defaultActiveOnShare,
        maxCatalogSkills: params.maxCatalogSkills,
      });
      catalogByScope.set(key, resolution);
    }
    return resolution;
  };

  const resolveMcpServerNames = () => {
    mcpServerNames ??= Promise.resolve(
      params.getAccessibleMcpServerNames?.(params.userId, params.userRole) ?? [],
    )
      .then((names) => [...new Set([...(names ?? []), ...(params.configuredMcpServerNames ?? [])])])
      .catch((error) => {
        logger.warn(
          '[createLazyAgentHistoryResolver] Failed to resolve MCP names for lazy history normalization:',
          error,
        );
        return [...new Set(params.configuredMcpServerNames ?? [])];
      });
    return mcpServerNames;
  };

  return {
    async resolve({ agent, codeExecutionAvailable, memoryAvailable }) {
      const scopedSkillIds = resolveAgentScopedSkillIds({
        agent,
        accessibleSkillIds: params.accessibleSkillIds,
        skillsCapabilityEnabled: params.skillsCapabilityEnabled,
        ephemeralSkillsToggle: params.ephemeralSkillsToggle,
      });
      const scopedEditableSkillIds = resolveAgentScopedSkillIds({
        agent,
        accessibleSkillIds: params.editableSkillIds,
        skillsCapabilityEnabled: params.skillsCapabilityEnabled,
        ephemeralSkillsToggle: params.ephemeralSkillsToggle,
      });
      const [alwaysApplySkillPrimes, catalog] = await Promise.all([
        resolveAlwaysApply(scopedSkillIds),
        resolveCatalog(scopedSkillIds),
      ]);
      const configuredAndSkillToolNames = [
        ...(agent.tools ?? []),
        ...alwaysApplySkillPrimes.flatMap((prime) => prime.allowedTools ?? []),
      ];
      const historicalMcpServerNames = configuredAndSkillToolNames.some((name) =>
        name.includes(Constants.mcp_delimiter),
      )
        ? await resolveMcpServerNames()
        : [];
      const skillAuthoringAvailable =
        params.canAuthorSkillFiles?.({ agent, scopedEditableSkillIds }) === true;

      return {
        alwaysApplySkillPrimes,
        historicalMcpServerNames,
        skillAuthoringAvailable,
        historicalToolNames: Array.from(
          buildHistoricalToolNames({
            configuredToolNames: agent.tools,
            alwaysApplyToolNames: alwaysApplySkillPrimes.flatMap(
              (prime) => prime.allowedTools ?? [],
            ),
            toolOptions: agent.tool_options,
            rawMcpServerNames: historicalMcpServerNames,
            codeExecutionAvailable,
            memoryAvailable: memoryAvailable && agent.tools?.includes(Tools.memory) === true,
            skillsAvailable: catalog.visibleCount > 0,
            skillFileAccessAvailable: catalog.activeSkills.length > 0,
            skillAuthoringAvailable,
            deferredToolsAvailable: params.deferredToolsAvailable,
            programmaticToolsAvailable: params.programmaticToolsAvailable,
            backgroundToolsAvailable: params.backgroundToolsAvailable,
          }),
        ),
      };
    },
  };
}
