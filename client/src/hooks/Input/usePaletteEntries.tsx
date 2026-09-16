import React, { useMemo, useEffect, useRef, useCallback } from 'react';
import { MCPIcon } from '@librechat/client';
import { useRecoilValue, useSetRecoilState } from 'recoil';
import {
  Brain,
  Globe,
  Layers,
  Settings,
  X,
  FolderSearch,
  WandSparkles,
  SquareChevronRight,
} from 'lucide-react';
import {
  AuthType,
  Permissions,
  ArtifactModes,
  PermissionTypes,
  isEphemeralAgentId,
  defaultAgentCapabilities,
} from 'librechat-data-provider';
import type { TSkillSummary, TToolFavoriteType } from 'librechat-data-provider';
import {
  useHasAccess,
  useAuthContext,
  useHasMemoryAccess,
  useAgentCapabilities,
  useSkillActiveState,
} from '~/hooks';
import { filterSkillsForPopover } from '~/components/Chat/Input/SkillsCommand';
import { useAgentsMapContext, useBadgeRowContext } from '~/Providers';
import { useSkillsInfiniteQuery } from '~/data-provider';
import store, { ephemeralAgentByConvoId } from '~/store';
import useLocalize from '~/hooks/useLocalize';

export type PaletteSection = 'tool' | 'skill' | 'mcp';

/**
 * One selectable row in the composer palette. Tools, skills and MCP servers are
 * normalized to the same shape so search, favouriting and rendering each run
 * once over a single list rather than per source.
 */
export interface PaletteMode {
  id: string;
  label: string;
  active: boolean;
  onSelect: () => void;
  /** When set, the palette row renders this instead of the text pill (e.g. a
   *  gear for Configure). Icon modes stay off the bar chip so they do not
   *  open a Configure/chevron menu. */
  icon?: React.ReactNode;
}

export interface PaletteEntry {
  key: string;
  itemType: TToolFavoriteType;
  itemId: string;
  label: string;
  description?: string;
  icon: React.ReactNode;
  section: PaletteSection;
  active: boolean;
  /** Keeps an inactive built-in available as a prompt-bar quick control. */
  pinned: boolean;
  /** Temporary catalog placeholders do not have a durable favorite identity. */
  favoritable?: boolean;
  onSelect: () => void;
  /** Removes a persistent pin without changing the tool's active state. */
  onUnpin?: () => void;
  /** Refinements of this tool, rendered as inline pills on the row while it is
   *  on. Not separately favouritable: they only exist within the parent. */
  modes?: PaletteMode[];
}

/** Accumulates skill pages so client-side search covers the full catalog. */
function useAllSkills(enabled: boolean, openRevision: number): TSkillSummary[] {
  const { data, isError, fetchNextPage, hasNextPage, isFetchingNextPage, refetch } =
    useSkillsInfiniteQuery({ limit: 50 }, { enabled });

  /* Circuit breaker: once any page request fails, stop auto-fetching so a
     transient API error does not turn into an unbounded retry loop. A later
     successful fetch (React Query refetching in the background, or the user
     reopening the palette) re-arms pagination; a repeat failure re-trips it. */
  const blockedRef = useRef(false);
  const previousOpenRevisionRef = useRef(openRevision);
  useEffect(() => {
    if (isError) {
      blockedRef.current = true;
    } else if (data != null) {
      blockedRef.current = false;
    }
  }, [isError, data]);

  useEffect(() => {
    if (previousOpenRevisionRef.current === openRevision) {
      return;
    }
    previousOpenRevisionRef.current = openRevision;
    if (enabled && isError) {
      blockedRef.current = false;
      void refetch();
    }
  }, [enabled, isError, openRevision, refetch]);

  useEffect(() => {
    if (blockedRef.current || isError || !enabled) {
      return;
    }
    if (hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [enabled, hasNextPage, isFetchingNextPage, isError, fetchNextPage]);

  return useMemo(() => {
    if (!data?.pages) {
      return [];
    }
    const all: TSkillSummary[] = [];
    for (const page of data.pages) {
      for (const skill of page.skills) {
        all.push(skill);
      }
    }
    return all;
  }, [data?.pages]);
}

export default function usePaletteEntries({
  conversationId,
  agentId,
  enabled = true,
  toolsEnabled = enabled,
  catalogEnabled = true,
  catalogOpenRevision = 0,
}: {
  conversationId: string;
  agentId?: string | null;
  /** Endpoints without a tool row discard these, so there is nothing to fetch
   *  or build for them. */
  enabled?: boolean;
  /** Whether ephemeral built-ins and MCP servers belong to this endpoint. */
  toolsEnabled?: boolean;
  /** Whether to walk the full skills catalog. The bar keeps this off until the
   *  palette has actually been opened: following every cursor on mount pulled
   *  a deployment's whole catalog into every composer that was merely visited. */
  catalogEnabled?: boolean;
  /** Increments on each palette open so a failed catalog walk can retry. */
  catalogOpenRevision?: number;
}): PaletteEntry[] {
  const localize = useLocalize();
  const context = useBadgeRowContext();
  const agentsMap = useAgentsMapContext();
  const { isActive } = useSkillActiveState();
  const setEphemeralAgent = useSetRecoilState(ephemeralAgentByConvoId(conversationId));
  const pendingManualSkills = useRecoilValue(store.pendingManualSkillsByConvoId(conversationId));
  const setPendingManualSkills = useSetRecoilState(
    store.pendingManualSkillsByConvoId(conversationId),
  );

  const {
    codeEnabled,
    memoryEnabled,
    webSearchEnabled,
    artifactsEnabled,
    fileSearchEnabled,
    skillsEnabled,
  } = useAgentCapabilities(context?.agentsConfig?.capabilities ?? defaultAgentCapabilities);

  const canUseWebSearch = useHasAccess({
    permissionType: PermissionTypes.WEB_SEARCH,
    permission: Permissions.USE,
  });
  const canRunCode = useHasAccess({
    permissionType: PermissionTypes.RUN_CODE,
    permission: Permissions.USE,
  });
  const canUseFileSearch = useHasAccess({
    permissionType: PermissionTypes.FILE_SEARCH,
    permission: Permissions.USE,
  });
  const canUseMcp = useHasAccess({
    permissionType: PermissionTypes.MCP_SERVERS,
    permission: Permissions.USE,
  });
  const canUseSkills = useHasAccess({
    permissionType: PermissionTypes.SKILLS,
    permission: Permissions.USE,
  });
  const { user } = useAuthContext();
  /* Personalization is the user's own opt-out and the backend refuses to
     register the memory tools once it is off, so role access and the global
     capability are not enough to offer the toggle. */
  const canUseMemory = useHasMemoryAccess() && user?.personalization?.memories !== false;

  const skillsListable = enabled && canUseSkills && skillsEnabled;
  const allSkills = useAllSkills(skillsListable && catalogEnabled, catalogOpenRevision);

  /* Mirrors backend `resolveAgentScopedSkillIds`: ephemeral agents see the full
     catalog; persisted agents gate on `skills_enabled` and fail closed while
     `agentsMap` is hydrating or when the agent is missing from it. */
  const agentSkillIds = useMemo<string[] | null | undefined>(() => {
    if (!agentId || isEphemeralAgentId(agentId)) {
      return undefined;
    }
    if (!agentsMap) {
      return [];
    }
    const agent = agentsMap[agentId];
    if (!agent || agent.skills_enabled !== true) {
      return [];
    }
    return Array.isArray(agent.skills) && agent.skills.length > 0 ? agent.skills : undefined;
  }, [agentId, agentsMap]);

  /* A toggle, like every other row: picking a skill used to be one-way, so the
     only way to undo a mis-click was to find the chip in the tray. */
  const toggleSkill = useCallback(
    (name: string) => {
      if (pendingManualSkills.includes(name)) {
        setPendingManualSkills((prev) => prev.filter((staged) => staged !== name));
        return;
      }
      setEphemeralAgent((agent) =>
        agent?.skills === true ? agent : { ...(agent ?? {}), skills: true },
      );
      setPendingManualSkills((prev) => (prev.includes(name) ? prev : [...prev, name]));
    },
    [pendingManualSkills, setEphemeralAgent, setPendingManualSkills],
  );

  return useMemo(() => {
    const entries: PaletteEntry[] = [];
    if (!context || !enabled) {
      return entries;
    }

    const {
      webSearch,
      codeInterpreter,
      fileSearch,
      skills,
      memory,
      artifacts,
      mcpServerManager,
      searchApiKeyForm,
    } = context;

    const pushTool = (
      itemId: string,
      label: string,
      icon: React.ReactNode,
      active: boolean,
      pinned: boolean,
      onSelect: () => void,
      onUnpin: () => void,
      modes?: PaletteMode[],
    ) => {
      entries.push({
        key: `builtin:${itemId}`,
        itemType: 'builtin',
        itemId,
        label,
        icon,
        section: 'tool',
        active,
        pinned,
        onSelect,
        onUnpin,
        modes,
      });
    };

    if (toolsEnabled && canUseWebSearch && webSearchEnabled) {
      /* Same rule the old tools menu used for its gear: only credentials the
         user can actually provide are editable. Toggling opens the key dialog
         on its own while unauthenticated, so this pill is what keeps existing
         credentials reachable: editing, switching provider or revoking. */
      const authTypes = webSearch.authData?.authTypes ?? [];
      const searchConfigurable =
        authTypes.length === 0 ||
        !authTypes.every(([, authType]) => authType === AuthType.SYSTEM_DEFINED);
      pushTool(
        'web_search',
        localize('com_ui_web_search'),
        <Globe className="icon-md" aria-hidden="true" />,
        webSearch.toggleState === true,
        webSearch.isPinned === true,
        () => webSearch.debouncedChange({ value: !webSearch.toggleState }),
        () => webSearch.setIsPinned(false),
        searchConfigurable && searchApiKeyForm != null
          ? [
              {
                id: 'configure',
                label: localize('com_ui_configure'),
                active: false,
                icon: <Settings className="h-4 w-4" aria-hidden="true" />,
                onSelect: () => searchApiKeyForm.setIsDialogOpen(true),
              },
            ]
          : undefined,
      );
    }

    if (toolsEnabled && canRunCode && codeEnabled) {
      pushTool(
        'execute_code',
        localize('com_ui_run_code'),
        <SquareChevronRight className="icon-md" aria-hidden="true" />,
        codeInterpreter.toggleState === true,
        codeInterpreter.isPinned === true,
        () => codeInterpreter.debouncedChange({ value: !codeInterpreter.toggleState }),
        () => codeInterpreter.setIsPinned(false),
      );
    }

    if (toolsEnabled && canUseFileSearch && fileSearchEnabled) {
      pushTool(
        'file_search',
        localize('com_assistants_file_search'),
        <FolderSearch className="icon-md" aria-hidden="true" />,
        fileSearch.toggleState === true,
        fileSearch.isPinned === true,
        () => fileSearch.debouncedChange({ value: !fileSearch.toggleState }),
        () => fileSearch.setIsPinned(false),
      );
    }

    if (toolsEnabled && skillsListable) {
      pushTool(
        'skills',
        localize('com_ui_skills'),
        <WandSparkles className="icon-md" aria-hidden="true" />,
        skills.toggleState === true,
        skills.isPinned === true,
        () => skills.debouncedChange({ value: !skills.toggleState }),
        () => skills.setIsPinned(false),
      );
    }

    if (toolsEnabled && canUseMemory && memoryEnabled) {
      pushTool(
        'memory',
        localize('com_ui_memory'),
        <Brain className="icon-md" aria-hidden="true" />,
        memory.toggleState === true,
        memory.isPinned === true,
        () => memory.debouncedChange({ value: !memory.toggleState }),
        () => memory.setIsPinned(false),
      );
    }

    if (toolsEnabled && artifactsEnabled) {
      const stored = artifacts.toggleState;
      const mode = stored == null || stored === false ? '' : String(stored);
      const artifactsOn = mode !== '';
      /* Anything on that is not an explicit generation mode counts as Default:
         the toggle has historically also held a bare `true`, which would
         otherwise leave every mode unchecked. */
      const isDefault =
        artifactsOn && mode !== ArtifactModes.SHADCNUI && mode !== ArtifactModes.CUSTOM;
      /* The two generation modes only mean anything once artifacts are on, and
         each toggles back to DEFAULT rather than off; same semantics the old
         `ArtifactsSubMenu` had, as inline pills instead of two long rows. */
      const buildMode = (id: string, label: string, target: string): PaletteMode => ({
        id,
        label,
        active: mode === target,
        onSelect: () =>
          artifacts.debouncedChange({ value: mode === target ? ArtifactModes.DEFAULT : target }),
      });
      pushTool(
        'artifacts',
        localize('com_ui_artifacts'),
        <Layers className="icon-md" aria-hidden="true" />,
        artifactsOn,
        artifacts.isPinned === true,
        () => artifacts.debouncedChange({ value: artifactsOn ? '' : ArtifactModes.DEFAULT }),
        () => artifacts.setIsPinned(false),
        artifactsOn
          ? [
              {
                id: 'default',
                label: localize('com_ui_default'),
                active: isDefault,
                onSelect: () => artifacts.debouncedChange({ value: ArtifactModes.DEFAULT }),
              },
              buildMode('shadcn', localize('com_ui_shadcnui'), ArtifactModes.SHADCNUI),
              buildMode('custom', localize('com_ui_custom_prompt'), ArtifactModes.CUSTOM),
            ]
          : undefined,
      );
    }

    if (skillsListable) {
      const staged = new Set(pendingManualSkills);
      /* Manual skills are primed by name server-side (`resolveManualSkills`),
         so records sharing a name are one selectable thing however many of them
         the catalog holds. Listed once each: otherwise every copy lit up when
         any was picked, while the tray (keyed by name) showed a single chip. */
      const listed = new Set<string>();
      for (const skill of filterSkillsForPopover(allSkills, { agentSkillIds, isActive })) {
        if (listed.has(skill.name)) {
          continue;
        }
        listed.add(skill.name);
        entries.push({
          key: `skill:${skill._id}`,
          itemType: 'skill',
          itemId: skill._id,
          label: skill.displayTitle ?? skill.name,
          description: skill.description,
          icon: <WandSparkles className="icon-md" aria-hidden="true" />,
          section: 'skill',
          active: staged.has(skill.name),
          pinned: false,
          onSelect: () => toggleSkill(skill.name),
        });
      }
      /* Skills staged by name (the slash command, or a draft restored before
         the catalog loads) still need an entry, or their chips in the bar
         would vanish while the catalog is not held. */
      for (const name of pendingManualSkills) {
        if (listed.has(name)) {
          continue;
        }
        listed.add(name);
        entries.push({
          key: `skill:staged:${name}`,
          itemType: 'skill',
          itemId: name,
          label: name,
          icon: <WandSparkles className="icon-md" aria-hidden="true" />,
          section: 'skill',
          active: true,
          pinned: false,
          favoritable: false,
          onSelect: () => toggleSkill(name),
        });
      }
    }

    const {
      selectableServers,
      mcpValues,
      toggleServerSelection,
      connectionStatus,
      initializeServer,
      getServerStatusIconProps,
    } = mcpServerManager ?? {};
    if (toolsEnabled && canUseMcp && selectableServers) {
      const selected = new Set(mcpValues ?? []);
      for (const server of selectableServers) {
        const title = server.config?.title || server.serverName;
        const statusProps = getServerStatusIconProps?.(server.serverName);
        /* A row for a server that is not connected routes through the manager
           instead of blindly selecting: credentials first when the server wants
           custom variables, otherwise a reinitialize, which runs the OAuth
           flow when needed and selects the server itself once it is ready.
           Selecting an unusable server here used to be a dead end: every
           connect, authenticate and retry control lived in the menu this
           palette replaced. */
        const selectServer = () => {
          if (selected.has(server.serverName)) {
            toggleServerSelection?.(server.serverName);
            return;
          }
          /* An unknown status means the server has not reported a connection
             yet, which is not the same as being connected: treat it like a
             disconnected server so it initializes before it can be selected. */
          if (connectionStatus?.[server.serverName]?.connectionState !== 'connected') {
            if (statusProps?.isInitializing) {
              return;
            }
            if (statusProps?.hasCustomUserVars) {
              statusProps.onConfigClick({
                stopPropagation: () => {},
                preventDefault: () => {},
              } as React.MouseEvent);
              return;
            }
            void initializeServer?.(server.serverName);
            return;
          }
          toggleServerSelection?.(server.serverName);
        };
        entries.push({
          key: `mcp:${server.serverName}`,
          itemType: 'mcp',
          itemId: server.serverName,
          label: title,
          description: server.config?.description,
          /* Servers ship their own branding; fall back to the generic MCP mark
             so a server without `iconPath` still reads as an MCP server rather
             than borrowing an unrelated tool glyph. */
          icon:
            server.config?.iconPath != null && server.config.iconPath !== '' ? (
              <img
                src={server.config.iconPath}
                alt=""
                aria-hidden="true"
                className="h-4 w-4 rounded-sm object-contain"
              />
            ) : (
              <MCPIcon className="h-4 w-4" aria-hidden="true" />
            ),
          section: 'mcp',
          active: selected.has(server.serverName),
          pinned: false,
          onSelect: selectServer,
          modes:
            statusProps?.isInitializing === true && statusProps.canCancel === true
              ? [
                  {
                    id: 'cancel',
                    label: localize('com_ui_cancel'),
                    active: false,
                    icon: <X className="h-4 w-4" aria-hidden="true" />,
                    onSelect: () =>
                      statusProps.onCancel({
                        stopPropagation: () => {},
                        preventDefault: () => {},
                      } as React.MouseEvent),
                  },
                ]
              : undefined,
        });
      }
    }

    return entries;
  }, [
    context,
    enabled,
    toolsEnabled,
    localize,
    canUseMcp,
    canRunCode,
    codeEnabled,
    allSkills,
    isActive,
    toggleSkill,
    pendingManualSkills,
    canUseMemory,
    memoryEnabled,
    agentSkillIds,
    skillsListable,
    canUseWebSearch,
    webSearchEnabled,
    artifactsEnabled,
    canUseFileSearch,
    fileSearchEnabled,
  ]);
}
