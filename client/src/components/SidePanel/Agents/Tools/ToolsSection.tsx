import { useState, useMemo, useCallback } from 'react';
import { Plus } from 'lucide-react';
import { useFormContext, useWatch } from 'react-hook-form';
import { Label, OGDialog, OGDialogTemplate, useToastContext } from '@librechat/client';
import {
  PermissionTypes,
  Permissions,
  SkillsScope,
  AgentCapabilities,
  resolveAgentSkillsScope,
  removeCodeExecutionCaller,
} from 'librechat-data-provider';
import type { TPlugin } from 'librechat-data-provider';
import type { CapabilityFileCounts } from './items/capabilities';
import type { AgentItem } from './items/types';
import type { AgentForm } from '~/common';
import {
  useAgentFileEntries,
  useAgentItems,
  useResolvedSkills,
  useUninstallToolCredentials,
} from './hooks';
import { useSkillsInfiniteQuery, useDeleteAgentAction } from '~/data-provider';
import { requiresFileManagerRemoval } from './items/capabilities';
import { useRemoveMCPTool, useVisibleTools } from '~/hooks/MCP';
import ToolsMarketplaceDialog from './ToolsMarketplaceDialog';
import { computeToggleAction } from './items/mutations';
import { useLocalize, useHasAccess } from '~/hooks';
import { useAgentPanelContext } from '~/Providers';
import ItemDialog from './ItemDialog/ItemDialog';
import { mcpAllToken } from './items/selectors';
import { isEphemeralAgent } from '~/common';
import SkillsSection from './SkillsSection';
import SkillsDialog from './SkillsDialog';
import ToolRow from './ToolRow';

interface Props {
  agentId: string;
}

export default function ToolsSection({ agentId }: Props) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const [open, setOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [dialogItem, setDialogItem] = useState<AgentItem | null>(null);
  const [pendingActionRemoval, setPendingActionRemoval] = useState<string | null>(null);
  const [pendingMcpRemoval, setPendingMcpRemoval] = useState<string | null>(null);

  const { control, getValues, setValue } = useFormContext<AgentForm>();
  const { agentsConfig, regularTools, mcpServersMap } = useAgentPanelContext();
  const mcpServerNames = useMemo(() => Array.from(mcpServersMap?.keys() ?? []), [mcpServersMap]);
  const { removeTool: removeMCPTool } = useRemoveMCPTool({ serverNames: mcpServerNames });
  const deleteAgentAction = useDeleteAgentAction({
    onSuccess: () => {
      showToast({
        message: localize('com_assistants_delete_actions_success'),
        status: 'success',
      });
    },
    onError: (error) => {
      showToast({
        message: (error as Error).message || localize('com_assistants_delete_actions_error'),
        status: 'error',
      });
    },
  });

  const hasSkillsAccess = useHasAccess({
    permissionType: PermissionTypes.SKILLS,
    permission: Permissions.USE,
  });
  const skillsEnabled = useMemo(
    () => agentsConfig?.capabilities?.includes(AgentCapabilities.skills) ?? false,
    [agentsConfig],
  );
  const showSkills = hasSkillsAccess && skillsEnabled;
  /** The same infinite query the section and the picker use, so all three
   *  consumers share one cache entry and one request. A plain list query hits
   *  the same endpoint under a different key, which React Query cannot
   *  deduplicate: the first page would be fetched twice. Only the first page
   *  is needed here, and pagination stays driven by whoever opens a list. */
  const { data: skillsData } = useSkillsInfiniteQuery({ limit: 100 }, { enabled: showSkills });
  /** `undefined` until the first page lands: `useResolvedSkills` treats it as
   *  "not loaded yet" and skips its per-id fallback lookups. */
  const skillSummaries = useMemo(
    () => (skillsData ? skillsData.pages.flatMap((page) => page.skills) : undefined),
    [skillsData],
  );
  const skillsValue = useWatch({ control, name: 'skills' });
  const skillsEnabledValue = useWatch({ control, name: 'skills_enabled' });
  const skillsScopeValue = useWatch({ control, name: 'skills_scope' });
  /** Only Selected renders allowlist rows, so the per-id fallback lookups are
   *  worth issuing only there. An All-scoped agent keeps its previous picks,
   *  which would otherwise cost one request per retained id on every view. */
  const skillsMode = resolveAgentSkillsScope(skillsValue, skillsEnabledValue, skillsScopeValue);
  const resolvedSkills = useResolvedSkills(skillSummaries, skillsMode === SkillsScope.selected);

  const uninstallToolCredentials = useUninstallToolCredentials();

  const { selected, tools } = useAgentItems({
    agentId,
    skills: resolvedSkills,
    skillsPermission: showSkills,
  });

  const { knowledgeFiles, codeFiles } = useAgentFileEntries();
  const fileCounts: CapabilityFileCounts = useMemo(
    () => ({ knowledge_files: knowledgeFiles.length, code_files: codeFiles.length }),
    [knowledgeFiles, codeFiles],
  );

  const opensFileManagerOnRemove = useCallback(
    (item: AgentItem): boolean =>
      item.kind === 'builtin' && requiresFileManagerRemoval(item.id, fileCounts),
    [fileCounts],
  );

  const handleQuickRemove = useCallback(
    (item: AgentItem) => {
      if (opensFileManagerOnRemove(item)) {
        setDialogItem(item);
        return;
      }
      const patch = computeToggleAction(item, { selected: true });
      switch (patch.type) {
        case 'builtin':
          setValue(patch.field as keyof AgentForm, patch.value as never, { shouldDirty: true });
          if (patch.field === AgentCapabilities.execute_code && patch.value === false) {
            setValue('tool_options', removeCodeExecutionCaller(getValues('tool_options')), {
              shouldDirty: true,
            });
          }
          break;
        case 'tool-remove': {
          const current = (getValues('tools') ?? []) as string[];
          setValue(
            'tools',
            current.filter((t) => t !== patch.id),
            { shouldDirty: true },
          );
          uninstallToolCredentials(patch.id);
          break;
        }
        case 'skill-remove': {
          /** The mode is explicit, so emptying the allowlist stays in
           *  `selected` rather than silently disabling skills. */
          const current = (getValues('skills') ?? []) as string[];
          setValue(
            'skills',
            current.filter((s) => s !== patch.id),
            { shouldDirty: true },
          );
          break;
        }
        case 'mcp-remove':
          setPendingMcpRemoval(patch.serverName);
          break;
        case 'action-remove':
          setPendingActionRemoval(patch.actionId);
          break;
        default:
          break;
      }
    },
    [getValues, setValue, uninstallToolCredentials, opensFileManagerOnRemove],
  );

  const confirmMcpRemoval = useCallback(() => {
    if (pendingMcpRemoval == null) {
      return;
    }
    removeMCPTool(pendingMcpRemoval);
    setPendingMcpRemoval(null);
  }, [pendingMcpRemoval, removeMCPTool]);

  const confirmActionRemoval = useCallback(() => {
    if (pendingActionRemoval == null) {
      return;
    }
    if (isEphemeralAgent(agentId)) {
      showToast({
        message: localize('com_agents_no_agent_id_error'),
        status: 'error',
      });
      setPendingActionRemoval(null);
      return;
    }
    deleteAgentAction.mutate({ action_id: pendingActionRemoval, agent_id: agentId });
    setPendingActionRemoval(null);
  }, [pendingActionRemoval, agentId, deleteAgentAction, showToast, localize]);

  const { mcpServerNames: attachedMcpServers } = useVisibleTools(
    tools,
    regularTools ?? undefined,
    mcpServersMap ?? new Map(),
  );

  /** MCP servers still referenced by the agent's tools but absent from the available
   * servers map (removed from config, or a legacy server-only token). The catalog is
   * built from available servers, so these would otherwise be invisible and
   * unremovable — surface them as removable "needs setup" rows, mirroring the old
   * UnconfiguredMCPTool. */
  const orphanedMcpItems = useMemo<AgentItem[]>(
    () =>
      attachedMcpServers
        .filter((name) => mcpServersMap?.has(name) !== true)
        .map((name) => ({
          kind: 'mcp',
          id: name,
          name,
          description: '',
          iconKey: 'mcp',
          status: 'needs_setup',
          toolCount: 0,
          server: {
            serverName: name,
            tools: [],
            isConfigured: false,
            isConnected: false,
            metadata: { name, pluginKey: name, description: '' } as TPlugin,
          },
        })),
    [attachedMcpServers, mcpServersMap],
  );

  /** MCP rows show how many of the server's tools are enabled for this agent, not
   * the total the server exposes, so the count reflects what the agent can use. */
  const toolItems = useMemo(() => {
    const enabled = new Set(tools);
    const withCounts = selected
      .filter((item) => item.kind !== 'skill')
      .map((item) =>
        item.kind === 'mcp'
          ? {
              ...item,
              toolCount: enabled.has(mcpAllToken(item.id))
                ? (item.server.tools ?? []).length
                : (item.server.tools ?? []).filter((t) => enabled.has(t.tool_id)).length,
            }
          : item,
      );
    return [...withCounts, ...orphanedMcpItems];
  }, [selected, orphanedMcpItems, tools]);
  const skillItems = useMemo(() => selected.filter((item) => item.kind === 'skill'), [selected]);

  return (
    <>
      <SelectedSection
        title={localize('com_ui_tools_section_title')}
        addLabel={localize('com_ui_add_tools')}
        emptyLabel={localize('com_ui_tools_empty')}
        emptyHint={localize('com_ui_tools_empty_hint')}
        items={toolItems}
        onAdd={() => setOpen(true)}
        onInfo={setDialogItem}
        onRemove={handleQuickRemove}
      />
      {showSkills && (
        <SkillsSection
          items={skillItems}
          onAdd={() => setSkillsOpen(true)}
          onInfo={setDialogItem}
          onRemove={handleQuickRemove}
        />
      )}
      {open && <ToolsMarketplaceDialog open={open} onOpenChange={setOpen} agentId={agentId} />}
      {skillsOpen && (
        <SkillsDialog open={skillsOpen} onOpenChange={setSkillsOpen} agentId={agentId} />
      )}
      <ItemDialog item={dialogItem} agentId={agentId} onClose={() => setDialogItem(null)} />
      <OGDialog
        open={pendingActionRemoval != null}
        onOpenChange={(value) => {
          if (!value) {
            setPendingActionRemoval(null);
          }
        }}
      >
        <OGDialogTemplate
          showCloseButton={false}
          title={localize('com_ui_delete_action')}
          className="max-w-[450px]"
          main={
            <Label className="text-left text-sm font-medium">
              {localize('com_ui_delete_action_confirm')}
            </Label>
          }
          selection={{
            selectHandler: confirmActionRemoval,
            selectClasses:
              'bg-surface-destructive hover:bg-surface-destructive-hover transition-colors duration-200 text-text-on-status',
            selectText: localize('com_ui_delete'),
          }}
        />
      </OGDialog>
      <OGDialog
        open={pendingMcpRemoval != null}
        onOpenChange={(value) => {
          if (!value) {
            setPendingMcpRemoval(null);
          }
        }}
      >
        <OGDialogTemplate
          showCloseButton={false}
          title={localize('com_ui_delete_tool')}
          className="max-w-[450px]"
          main={
            <Label className="text-left text-sm font-medium">
              {localize('com_ui_delete_tool_confirm')}
            </Label>
          }
          selection={{
            selectHandler: confirmMcpRemoval,
            selectClasses:
              'bg-surface-destructive hover:bg-surface-destructive-hover transition-colors duration-200 text-text-on-status',
            selectText: localize('com_ui_delete'),
          }}
        />
      </OGDialog>
    </>
  );
}

interface SelectedSectionProps {
  title: string;
  addLabel: string;
  emptyLabel: string;
  emptyHint: string;
  items: AgentItem[];
  onAdd: () => void;
  onInfo: (item: AgentItem) => void;
  onRemove: (item: AgentItem) => void;
}

function SelectedSection({
  title,
  addLabel,
  emptyLabel,
  emptyHint,
  items,
  onAdd,
  onInfo,
  onRemove,
}: SelectedSectionProps) {
  const localize = useLocalize();
  const badge = items.length > 0 ? String(items.length) : undefined;
  return (
    <div className="mb-3 flex flex-col">
      <div className="mb-1 flex items-center justify-between">
        <label className="block text-[11px] font-medium uppercase tracking-wide text-text-secondary">
          {title}
          {badge != null && (
            <span className="ml-1.5 inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-surface-tertiary px-1.5 text-[10px] font-medium normal-case tracking-normal text-text-secondary">
              {badge}
            </span>
          )}
        </label>
        <button
          type="button"
          onClick={onAdd}
          aria-label={addLabel}
          className="inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-text-secondary transition hover:bg-surface-secondary hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-ring-primary"
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
          {localize('com_ui_add')}
        </button>
      </div>
      {items.length === 0 ? (
        <button
          type="button"
          onClick={onAdd}
          className="flex w-full flex-col items-center gap-1 rounded-xl border border-dashed border-border-light px-2 py-4 text-text-secondary transition-colors hover:border-border-medium hover:bg-surface-secondary hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-ring-primary"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          <span className="text-xs">{emptyLabel}</span>
          <span className="text-[11px] text-text-secondary">{emptyHint}</span>
        </button>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {items.map((item) => (
            <li key={`${item.kind}:${item.id}`}>
              <ToolRow item={item} onInfo={onInfo} onRemove={onRemove} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
