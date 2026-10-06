import { useMemo } from 'react';
import { MCPIcon, OpenAIMinimalIcon } from '@librechat/client';
import {
  Bot,
  Brain,
  Bookmark,
  NotebookPen,
  ScrollText,
  CalendarClock,
  ArrowRightToLine,
  SlidersHorizontal,
} from 'lucide-react';
import {
  Permissions,
  EModelEndpoint,
  PermissionTypes,
  isParamEndpoint,
  isAgentsEndpoint,
  isAssistantsEndpoint,
} from 'librechat-data-provider';
import type { TInterfaceConfig, TEndpointsConfig } from 'librechat-data-provider';
import type { NavLink } from '~/common';
import {
  useAgentCapabilities,
  useMCPServerManager,
  useGetAgentsConfig,
  useHasAccess,
} from '~/hooks';
import MCPBuilderPanel from '~/components/SidePanel/MCPBuilder/MCPBuilderPanel';
import AgentPanelSwitch from '~/components/SidePanel/Agents/AgentPanelSwitch';
import BookmarkPanel from '~/components/SidePanel/Bookmarks/BookmarkPanel';
import PanelSwitch from '~/components/SidePanel/Builder/PanelSwitch';
import { SchedulePanel } from '~/components/SidePanel/Schedules';
import Parameters from '~/components/SidePanel/Parameters/Panel';
import { MemoryPanel } from '~/components/SidePanel/Memories';
import { PromptsAccordion } from '~/components/Prompts';
import { SkillsAccordion } from '~/components/Skills';

export default function useSideNavLinks({
  hidePanel,
  keyProvided,
  endpoint,
  endpointType,
  interfaceConfig,
  endpointsConfig,
  includeHidePanel = true,
}: {
  hidePanel?: () => void;
  keyProvided: boolean;
  endpoint?: EModelEndpoint | null;
  endpointType?: EModelEndpoint | null;
  interfaceConfig: Partial<TInterfaceConfig>;
  endpointsConfig: TEndpointsConfig;
  includeHidePanel?: boolean;
}) {
  const hasAccessToPrompts = useHasAccess({
    permissionType: PermissionTypes.PROMPTS,
    permission: Permissions.USE,
  });
  const hasAccessToSkills = useHasAccess({
    permissionType: PermissionTypes.SKILLS,
    permission: Permissions.USE,
  });
  const hasAccessToBookmarks = useHasAccess({
    permissionType: PermissionTypes.BOOKMARKS,
    permission: Permissions.USE,
  });
  const hasAccessToMemories = useHasAccess({
    permissionType: PermissionTypes.MEMORIES,
    permission: Permissions.USE,
  });
  const hasAccessToReadMemories = useHasAccess({
    permissionType: PermissionTypes.MEMORIES,
    permission: Permissions.READ,
  });
  const hasAccessToAgents = useHasAccess({
    permissionType: PermissionTypes.AGENTS,
    permission: Permissions.USE,
  });
  const hasAccessToCreateAgents = useHasAccess({
    permissionType: PermissionTypes.AGENTS,
    permission: Permissions.CREATE,
  });
  const hasAccessToUseMCPSettings = useHasAccess({
    permissionType: PermissionTypes.MCP_SERVERS,
    permission: Permissions.USE,
  });
  const hasAccessToCreateMCP = useHasAccess({
    permissionType: PermissionTypes.MCP_SERVERS,
    permission: Permissions.CREATE,
  });
  const hasAccessToSchedules = useHasAccess({
    permissionType: PermissionTypes.SCHEDULES,
    permission: Permissions.USE,
  });
  const { availableMCPServers } = useMCPServerManager();

  const { agentsConfig } = useGetAgentsConfig({ endpointsConfig });
  const { skillsEnabled } = useAgentCapabilities(agentsConfig?.capabilities);

  const Links = useMemo(() => {
    const links: NavLink[] = [];

    if (
      endpointsConfig?.[EModelEndpoint.agents] &&
      hasAccessToAgents &&
      hasAccessToCreateAgents &&
      endpointsConfig[EModelEndpoint.agents].disableBuilder !== true
    ) {
      links.push({
        title: 'com_sidepanel_agent_builder',
        label: '',
        icon: Bot,
        id: EModelEndpoint.agents,
        Component: AgentPanelSwitch,
      });
    }

    if (
      isAssistantsEndpoint(endpoint) &&
      ((endpoint === EModelEndpoint.assistants &&
        endpointsConfig?.[EModelEndpoint.assistants] &&
        endpointsConfig[EModelEndpoint.assistants].disableBuilder !== true) ||
        (endpoint === EModelEndpoint.azureAssistants &&
          endpointsConfig?.[EModelEndpoint.azureAssistants] &&
          endpointsConfig[EModelEndpoint.azureAssistants].disableBuilder !== true)) &&
      keyProvided
    ) {
      links.push({
        title: 'com_sidepanel_assistant_builder',
        label: '',
        icon: OpenAIMinimalIcon,
        id: EModelEndpoint.assistants,
        Component: PanelSwitch,
      });
    }

    if (hasAccessToSkills && skillsEnabled) {
      links.push({
        title: 'com_ui_skills',
        label: '',
        icon: ScrollText,
        id: 'skills',
        Component: SkillsAccordion,
      });
    }

    // Scheduled chats are EXPERIMENTAL and default-OFF: the server enables them only
    // when an admin opts in explicitly, so ABSENT config means disabled here too.
    // Mirrors getLimits exactly — absent/null/`false` are all off, `true` is on, and the
    // object form is on unless it sets `use: false`. Any mismatch would show an entry
    // whose create/run operations the backend rejects.
    const schedulesConfig = interfaceConfig.schedules;
    const schedulesEnabled =
      schedulesConfig != null &&
      schedulesConfig !== false &&
      !(typeof schedulesConfig === 'object' && schedulesConfig.use === false);
    if (hasAccessToSchedules && schedulesEnabled) {
      links.push({
        title: 'com_ui_schedules',
        label: '',
        icon: CalendarClock,
        id: 'schedules',
        Component: SchedulePanel,
      });
    }

    if (hasAccessToPrompts) {
      links.push({
        title: 'com_ui_prompts',
        label: '',
        icon: NotebookPen,
        id: 'prompts',
        Component: PromptsAccordion,
      });
    }

    if (hasAccessToMemories && hasAccessToReadMemories) {
      links.push({
        title: 'com_ui_memories',
        label: '',
        icon: Brain,
        id: 'memories',
        Component: MemoryPanel,
      });
    }

    if (hasAccessToBookmarks) {
      links.push({
        title: 'com_sidepanel_conversation_tags',
        label: '',
        icon: Bookmark,
        id: 'bookmarks',
        Component: BookmarkPanel,
      });
    }

    if (
      interfaceConfig.parameters === true &&
      isParamEndpoint(endpoint ?? '', endpointType ?? '') === true &&
      !isAgentsEndpoint(endpoint) &&
      keyProvided
    ) {
      links.push({
        title: 'com_sidepanel_parameters',
        label: '',
        icon: SlidersHorizontal,
        id: 'parameters',
        Component: Parameters,
      });
    }

    if (
      (hasAccessToUseMCPSettings && availableMCPServers && availableMCPServers.length > 0) ||
      hasAccessToCreateMCP
    ) {
      links.push({
        title: 'com_nav_setting_mcp',
        label: '',
        icon: MCPIcon,
        id: 'mcp-builder',
        Component: MCPBuilderPanel,
      });
    }

    if (includeHidePanel && hidePanel) {
      links.push({
        title: 'com_sidepanel_hide_panel',
        label: '',
        icon: ArrowRightToLine,
        onClick: hidePanel,
        id: 'hide-panel',
      });
    }

    return links;
  }, [
    endpoint,
    endpointsConfig,
    keyProvided,
    hasAccessToAgents,
    hasAccessToCreateAgents,
    hasAccessToPrompts,
    hasAccessToSkills,
    skillsEnabled,
    hasAccessToMemories,
    hasAccessToReadMemories,
    hasAccessToSchedules,
    interfaceConfig.schedules,
    interfaceConfig.parameters,
    endpointType,
    hasAccessToBookmarks,
    availableMCPServers,
    hasAccessToUseMCPSettings,
    hasAccessToCreateMCP,
    includeHidePanel,
    hidePanel,
  ]);

  return Links;
}
