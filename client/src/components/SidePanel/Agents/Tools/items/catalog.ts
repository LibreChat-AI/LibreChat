import { AgentCapabilities } from 'librechat-data-provider';
import type { TPlugin, TSkillSummary, Action } from 'librechat-data-provider';
import type { AgentItem, SkillItem, BuiltinId } from './types';
import type { MCPServerInfo } from '~/common';
import { pluginNeedsAuth } from './auth';

/** Maps skill summaries to catalog items, flagging the current user's own skills. */
export function buildSkillItems(skills: TSkillSummary[], currentUserId?: string): SkillItem[] {
  return skills.map((skill) => ({
    kind: 'skill',
    id: skill._id,
    name: skill.name,
    description: skill.description ?? '',
    iconKey: 'skill',
    skill,
    ownedByUser: currentUserId != null && skill.author === currentUserId,
  }));
}

export interface BuildCatalogInputs {
  agentsConfig: { capabilities: string[] };
  regularTools: TPlugin[];
  mcpServersMap: Map<string, MCPServerInfo>;
  skills: TSkillSummary[];
  actions: Action[];
  /**
   * Role grants gating catalog inclusion. `mcp` and `skills` gate their own item
   * kinds; the rest gate the matching builtin (see `BUILTIN_ROLE_PERMISSIONS`) on
   * top of its admin-enabled capability, so a builtin has to clear both.
   */
  permissions: {
    mcp: boolean;
    skills: boolean;
    webSearch: boolean;
    runCode: boolean;
    fileSearch: boolean;
  };
  /**
   * Id of the signed-in user. When provided, skills authored by this user are
   * flagged `ownedByUser` so the "Made by you" view can surface them. Optional
   * to keep existing callers working; absent means no item is owned.
   */
  currentUserId?: string;
  /**
   * Maps a builtin capability id (e.g. `web_search`, `execute_code`) to whether
   * it still needs setup (USER_PROVIDED + unauthenticated). Threaded from
   * `useVerifyAgentToolAuth` by the caller. Absent entries leave `status`
   * undefined, so builtins are treated as ready until proven otherwise.
   */
  builtinAuthMap?: Map<string, boolean>;
  /**
   * Whether the Memory capability should be offered. Unlike the other builtins,
   * Memory is gated by permission and user personalization in addition to the
   * admin-enabled capability, so the caller collapses all of that into a single
   * flag (see `showMemory` in `ToolsSection`) instead of deriving it from
   * `agentsConfig.capabilities` here.
   */
  showMemory?: boolean;
  /**
   * Whether `web_search` uses USER_PROVIDED auth (a user-managed key). Drives the
   * cog-vs-info affordance on the web_search card/row: configurable only when a
   * user key exists; SYSTEM_DEFINED deployments have nothing to configure.
   */
  webSearchUserProvided?: boolean;
}

interface BuiltinDef {
  id: BuiltinId;
  iconKey: string;
  nameKey: string;
  descriptionKey: string;
}

const BUILTIN_DEFINITIONS: BuiltinDef[] = [
  {
    id: AgentCapabilities.execute_code,
    iconKey: 'execute_code',
    nameKey: 'com_ui_run_code',
    descriptionKey: 'com_agents_run_code_info',
  },
  {
    id: AgentCapabilities.web_search,
    iconKey: 'web_search',
    nameKey: 'com_ui_web_search',
    descriptionKey: 'com_agents_search_info',
  },
  {
    id: AgentCapabilities.artifacts,
    iconKey: 'artifacts',
    nameKey: 'com_ui_artifacts',
    descriptionKey: 'com_ui_artifacts_subtext',
  },
  {
    id: AgentCapabilities.file_search,
    iconKey: 'file_search',
    nameKey: 'com_assistants_file_search',
    descriptionKey: 'com_agents_file_search_info',
  },
];

/** Role grant each builtin needs on top of its capability. A builtin absent here
 *  (`artifacts`) carries no role permission and passes on the capability alone. */
const BUILTIN_ROLE_PERMISSIONS: Partial<Record<BuiltinId, 'webSearch' | 'runCode' | 'fileSearch'>> =
  {
    [AgentCapabilities.execute_code]: 'runCode',
    [AgentCapabilities.web_search]: 'webSearch',
    [AgentCapabilities.file_search]: 'fileSearch',
  };

function countEndpoints(settings: Action['settings']): number {
  if (settings == null) {
    return 0;
  }
  const paths = (settings as { paths?: unknown }).paths;
  if (paths == null || typeof paths !== 'object') {
    return 0;
  }
  return Object.keys(paths).length;
}

export function buildCatalog(inputs: BuildCatalogInputs): AgentItem[] {
  const items: AgentItem[] = [];

  const enabled = new Set(inputs.agentsConfig.capabilities);
  for (const def of BUILTIN_DEFINITIONS) {
    if (!enabled.has(def.id)) {
      continue;
    }
    const roleGrant = BUILTIN_ROLE_PERMISSIONS[def.id];
    if (roleGrant != null && !inputs.permissions[roleGrant]) {
      continue;
    }
    items.push({
      kind: 'builtin',
      id: def.id,
      iconKey: def.iconKey,
      name: def.nameKey,
      description: def.descriptionKey,
      status: inputs.builtinAuthMap?.get(def.id) === true ? 'needs_setup' : undefined,
      userProvidedAuth:
        def.id === AgentCapabilities.web_search ? inputs.webSearchUserProvided === true : undefined,
    });
  }

  /**
   * Native tool presented with the builtins (it ships with the app and pauses
   * the run like a first-class feature), while remaining an `agent.tools`
   * entry mechanically. Availability is its OWN capability (like execute_code /
   * web_search), NOT the generic `tools` one — the admin gates questions
   * independently via `endpoints.agents.capabilities` — AND the server must
   * still list the plugin (admin didn't filter it out).
   */
  if (
    enabled.has(AgentCapabilities.ask_user_question) &&
    inputs.regularTools.some((plugin) => plugin.pluginKey === 'ask_user_question')
  ) {
    items.push({
      kind: 'builtin',
      id: 'ask_user_question',
      iconKey: 'ask_user_question',
      name: 'com_ui_ask_user',
      description: 'com_agents_ask_user_info',
    });
  }

  if (inputs.showMemory) {
    items.push({
      kind: 'builtin',
      id: AgentCapabilities.memory,
      iconKey: 'memory',
      name: 'com_ui_memory',
      description: 'com_agents_memory_info',
    });
  }

  if (inputs.permissions.mcp) {
    for (const [name, server] of inputs.mcpServersMap) {
      /** Consume-only servers are provided to chat by the deployment and can't
       * be attached to an agent, so they never belong in the catalog. */
      if (server.consumeOnly === true) {
        continue;
      }
      items.push({
        kind: 'mcp',
        id: name,
        name,
        description: server.metadata?.description ?? '',
        iconKey: 'mcp',
        server,
        toolCount: server.tools?.length ?? 0,
        status: server.isConfigured === false ? 'needs_setup' : undefined,
      });
    }
  }

  if (enabled.has(AgentCapabilities.tools)) {
    for (const plugin of inputs.regularTools) {
      if (plugin.pluginKey === 'ask_user_question') {
        continue; // surfaced as a builtin above — don't double-list as a plugin
      }
      items.push({
        kind: 'tool',
        id: plugin.pluginKey,
        name: plugin.name ?? plugin.pluginKey,
        description: plugin.description ?? '',
        iconKey: 'tool',
        plugin,
        status: pluginNeedsAuth(plugin) ? 'needs_setup' : undefined,
      });
    }
  }

  if (inputs.permissions.skills) {
    items.push(...buildSkillItems(inputs.skills, inputs.currentUserId));
  }

  for (const action of inputs.actions) {
    items.push({
      kind: 'action',
      id: action.action_id,
      name: action.metadata?.domain ?? action.action_id,
      description: '',
      iconKey: 'action',
      action,
      endpointCount: countEndpoints(action.settings),
    });
  }

  return items;
}
