import { useState, useMemo, useEffect, useCallback } from 'react';
import { Clock, Code2, Captions, Zap } from 'lucide-react';
import { useFormContext, useWatch } from 'react-hook-form';
import { Button, Spinner, Checkbox, Skeleton } from '@librechat/client';
import {
  AgentCapabilities,
  Constants,
  splitMCPToolKey,
  normalizeServerName,
  buildServerNameAliases,
  stripServerNamePrefix,
} from 'librechat-data-provider';
import type { MCPServerStatus } from 'librechat-data-provider';
import type { MouseEvent } from 'react';
import type { TranslationKeys } from '~/hooks/useLocalize';
import type { McpItem } from '../../items/types';
import type { AgentForm } from '~/common';
import {
  useAgentCapabilities,
  useGetAgentsConfig,
  useMCPServerManager,
  useMCPToolOptions,
} from '~/hooks';
import { matchesMcpServer, mcpAllToken, mcpServerToken } from '../../items/selectors';
import { getStatusColor, getStatusTextKey } from '~/components/MCP/mcpServerUtils';
import MCPServerStatusIcon from '~/components/MCP/MCPServerStatusIcon';
import MCPConfigDialog from '~/components/MCP/MCPConfigDialog';
import McpOAuthDialog from '~/components/MCP/McpOAuthDialog';
import { useAgentPanelContext } from '~/Providers';
import { getIconForItem } from '../../items/icons';
import OptionToggle from '../../../OptionToggle';
import MCPToolItem from '../../../MCPToolItem';
import { Collapse } from '~/components/ui';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

interface StatusDisplay {
  labelKey: TranslationKeys;
  dotClass: string;
}

function getStatusDisplay(
  serverName: string,
  serverStatus: MCPServerStatus | undefined,
  isInitializing: boolean,
  isConfigured: boolean,
): StatusDisplay {
  if (!serverStatus && !isInitializing && !isConfigured) {
    return { labelKey: 'com_ui_tools_mcp_status_unconfigured', dotClass: 'bg-status-neutral' };
  }
  const connectionStatus = serverStatus ? { [serverName]: serverStatus } : undefined;
  const initializing = () => isInitializing;
  return {
    labelKey: getStatusTextKey(serverName, connectionStatus, initializing) as TranslationKeys,
    dotClass: cn(
      getStatusColor(serverName, connectionStatus, initializing),
      (isInitializing || serverStatus?.connectionState === 'connecting') && 'animate-pulse',
    ),
  };
}

interface Props {
  item: McpItem;
}

export default function McpSection({ item }: Props) {
  const localize = useLocalize();
  const { control, getValues, setValue } = useFormContext<AgentForm>();
  const {
    getServerStatusIconProps,
    getConfigDialogProps,
    initializeServer,
    isConnectionDeferred,
    resetConnectionDeferred,
    getOAuthUrl,
  } = useMCPServerManager();
  const [oauthOpen, setOauthOpen] = useState(false);
  const [oauthUrl, setOauthUrl] = useState<string | null>(null);
  const [prevReadyForAgent, setPrevReadyForAgent] = useState(false);
  const [autoSelectPending, setAutoSelectPending] = useState(false);
  const { mcpServersMap, mcpToolsLoading } = useAgentPanelContext();
  const { agentsConfig } = useGetAgentsConfig();
  const {
    codeEnabled,
    deferredToolsEnabled,
    programmaticToolsEnabled,
    backgroundToolsEnabled,
    toolIntentsEnabled,
  } = useAgentCapabilities(agentsConfig?.capabilities);
  const codeInterpreterSelected = useWatch({ control, name: AgentCapabilities.execute_code });
  const programmaticToolsAvailable =
    codeEnabled && programmaticToolsEnabled && codeInterpreterSelected === true;
  const {
    isToolDeferred,
    isToolProgrammatic,
    isToolBackground,
    isToolIntent,
    isToolProgrammaticOnly,
    toggleToolDefer,
    toggleToolProgrammatic,
    toggleToolBackground,
    toggleToolIntent,
    areAllToolsDeferred,
    areAllToolsProgrammatic,
    areAllToolsBackground,
    areAllToolsIntent,
    toggleDeferAll,
    toggleProgrammaticAll,
    toggleBackgroundAll,
    toggleIntentAll,
  } = useMCPToolOptions();

  const serverName = item.server.serverName;
  const serverToken = mcpServerToken(serverName);
  const serverAllToken = mcpAllToken(serverName);
  /** Live server data — `item.server` is a snapshot from card click and goes stale once
   * the MCP query refetches (e.g., after a server connects), so read from the live map. */
  const liveServer = mcpServersMap.get(serverName) ?? item.server;
  const tools = useMemo(() => liveServer.tools ?? [], [liveServer.tools]);
  const hasTools = tools.length > 0;

  /** Subscribe to the tools field so selection toggles re-render this section.
   * `getValues` is a non-reactive read and left the checkboxes visually stale. */
  const formTools = (useWatch({ control, name: 'tools' }) ?? []) as string[];
  /** Attached via the server-wide `mcp_all` wildcard when tools resolve at
   * chat-turn time rather than from the instance catalog. */
  const isWildcardAttached = formTools.includes(serverAllToken);

  /**
   * Maps a legacy raw-keyed form entry for THIS server to its current
   * (normalized) catalog id — an agent saved before tool keys embedded the
   * normalized server name would otherwise show its tools unchecked while the
   * runtime heal keeps them active, and per-tool updates could never replace
   * the legacy entry. Tokens and other servers' entries pass through.
   */
  const toNormalizedToolId = useCallback(
    (entry: string): string => {
      const normalizedName = normalizeServerName(serverName);
      if (
        normalizedName === serverName ||
        entry === serverToken ||
        entry === serverAllToken ||
        !entry.endsWith(`${Constants.mcp_delimiter}${serverName}`)
      ) {
        return entry;
      }
      /** Boundary-exact: this raw suffix could equally terminate a LONGER
       *  configured server name — resolve the entry once against every
       *  configured server (both spellings, longest match) and rewrite only
       *  when it truly belongs to THIS server, or the migration could
       *  reassign another server's persisted settings. */
      /** Include THIS server even when a stale catalog map omits it, so a
       *  missing entry doesn't misread as a collision. */
      const allServerNames = Array.from(new Set([...mcpServersMap.keys(), serverName]));
      const aliases = buildServerNameAliases(allServerNames);
      /** A SHADOWED server (its normalized slot claimed by another catalog
       *  name) keeps legacy keys raw — the runtime heal fails closed the
       *  same way; rewriting here would move this server's persisted
       *  options onto the winning server's key. */
      if (aliases.get(normalizedName) !== serverName) {
        return entry;
      }
      const [, parsed] = splitMCPToolKey(entry, [...allServerNames, ...aliases.keys()]);
      if (parsed == null || (aliases.get(parsed) ?? parsed) !== serverName) {
        return entry;
      }
      return `${entry.slice(0, entry.length - serverName.length)}${normalizedName}`;
    },
    [serverName, serverToken, serverAllToken, mcpServersMap],
  );

  /**
   * Second migration stage: catalog keys drop a redundant leading server-name
   * prefix, so a pre-strip persisted id would show its tool unchecked and a
   * per-tool toggle could silently drop it from the selection. The rewrite is
   * identity-verified — it only lands when the stripped catalog entry records
   * this exact raw name as its upstream tool — so a stale id for a removed
   * tool can never migrate onto a different sibling.
   */
  /** Constant-time lookups for the migration below — the form heal calls it
   *  per persisted key, so linear catalog scans go O(options × tools). */
  const toolsById = useMemo(() => new Map(tools.map((tool) => [tool.tool_id, tool])), [tools]);

  const toStrippedToolId = useCallback(
    (entry: string): string => {
      if (entry === serverToken || entry === serverAllToken || toolsById.has(entry)) {
        return entry;
      }
      const normalizedName = normalizeServerName(serverName);
      const [toolPart, parsed] = splitMCPToolKey(entry, [normalizedName]);
      if (parsed !== normalizedName) {
        return entry;
      }
      const strippedPart = stripServerNamePrefix(toolPart, normalizedName);
      if (strippedPart === toolPart) {
        return entry;
      }
      const strippedId = `${strippedPart}${Constants.mcp_delimiter}${normalizedName}`;
      const target = toolsById.get(strippedId);
      return target?.metadata.serverToolName === toolPart ? strippedId : entry;
    },
    [serverName, serverToken, serverAllToken, toolsById],
  );

  const toCurrentToolId = useCallback(
    (entry: string): string => toStrippedToolId(toNormalizedToolId(entry)),
    [toNormalizedToolId, toStrippedToolId],
  );

  const isServerSelection = useCallback(
    (token: string): boolean => {
      const allServerNames = Array.from(new Set([...mcpServersMap.keys(), serverName]));
      return (
        matchesMcpServer(token, serverName, allServerNames) ||
        tools.some((tool) => tool.tool_id === toCurrentToolId(token))
      );
    },
    [mcpServersMap, serverName, tools, toCurrentToolId],
  );

  /**
   * Migrates legacy raw-keyed `tool_options` for THIS server to the current
   * normalized ids the option toggles (defer / programmatic / background /
   * intent) read and write — otherwise a persisted option shows disabled
   * while the runtime heal keeps honoring it, and toggling the normalized
   * control leaves the raw entry behind. An existing normalized entry wins
   * over the legacy one on collision. Form state only; the user's next real
   * edit persists it.
   */
  const formToolOptions = useWatch({ control, name: 'tool_options' });
  useEffect(() => {
    if (!formToolOptions) {
      return;
    }
    const entries = Object.entries(formToolOptions);
    if (!entries.some(([key]) => toCurrentToolId(key) !== key)) {
      return;
    }
    const migrated: typeof formToolOptions = {};
    for (const [key, options] of entries) {
      if (toCurrentToolId(key) === key) {
        migrated[key] = options;
      }
    }
    for (const [key, options] of entries) {
      const target = toCurrentToolId(key);
      if (target === key) {
        continue;
      }
      migrated[target] = { ...options, ...migrated[target] };
    }
    setValue('tool_options', migrated);
  }, [formToolOptions, toCurrentToolId, setValue]);

  /** The `mcp_all` wildcard grants every server tool at runtime, so when the
   * server's tools ARE enumerable (e.g. it stopped being request-scoped), fold
   * the wildcard into the display as "all selected" — otherwise the dialog
   * would show unchecked boxes while runtime grants everything. Any selection
   * interaction then rewrites the form with concrete tool ids (the wildcard is
   * stripped by `updateFormTools`), converting the attachment on first touch. */
  const getSelectedTools = (): string[] => {
    if (isWildcardAttached) {
      return tools.map((t) => t.tool_id);
    }
    const formToolIds = new Set(formTools.map(toCurrentToolId));
    return tools.filter((t) => formToolIds.has(t.tool_id)).map((t) => t.tool_id);
  };

  /** Replace this server's tool selection while keeping the server attached: the
   * placeholder token is always rewritten, so deselect-all leaves the server
   * pinned with zero tools; only an explicit remove detaches it. The `mcp_all`
   * wildcard is also stripped unless explicitly re-passed in `next`, so a
   * per-tool selection always supersedes a stale wildcard (e.g. after a server
   * stops being request-scoped and its tools become enumerable). Legacy
   * raw-keyed and removed-tool entries count as this server's via boundary-safe
   * server matching, so a selection update REPLACES them instead of letting an
   * invisible stale tool survive every rewrite. */
  const updateFormTools = useCallback(
    (next: string[]) => {
      const current = (getValues('tools') ?? []) as string[];
      const otherTools = current.filter((tool) => !isServerSelection(tool));
      setValue('tools', [...otherTools, serverToken, ...next], { shouldDirty: true });
    },
    [getValues, isServerSelection, serverToken, setValue],
  );

  /** Servers without a visible per-tool catalog attach through the runtime wildcard.
   * Clearing it detaches the server instead of leaving an unusable server-only pin. */
  const toggleRuntimeTools = useCallback(
    (checked: boolean) => {
      const current = (getValues('tools') ?? []) as string[];
      const otherTools = current.filter((tool) => !isServerSelection(tool));
      setValue('tools', checked ? [...otherTools, serverToken, serverAllToken] : otherTools, {
        shouldDirty: true,
      });
    },
    [getValues, isServerSelection, serverAllToken, serverToken, setValue],
  );

  const toggleToolSelect = (toolId: string) => {
    const selected = getSelectedTools();
    const next = selected.includes(toolId)
      ? selected.filter((t) => t !== toolId)
      : [...selected, toolId];
    updateFormTools(next);
  };

  const toggleAll = (checked: boolean) => {
    updateFormTools(checked ? tools.map((t) => t.tool_id) : []);
  };

  const selectedTools = getSelectedTools();
  const allSelected = hasTools && selectedTools.length === tools.length;
  const allDeferred = areAllToolsDeferred(tools);
  const allProgrammatic = areAllToolsProgrammatic(tools);
  const programmaticBulkLabel = localize(
    allProgrammatic ? 'com_ui_mcp_unprogrammatic_all' : 'com_ui_mcp_programmatic_all',
  );
  const programmaticBulkTooltip =
    programmaticToolsAvailable || allProgrammatic
      ? programmaticBulkLabel
      : localize('com_ui_mcp_programmatic_requires_code');
  const allBackground = areAllToolsBackground(tools);
  /** Programmatic-only tools can never carry an intent label (the backend's
   *  `canInjectIntentParam` skips non-direct tools), so both the bulk toggle
   *  and its all-state only consider tools the label can actually reach. */
  const intentEligibleTools = tools.filter((tool) => !isToolProgrammaticOnly(tool.tool_id));
  const allIntent = areAllToolsIntent(intentEligibleTools);
  const statusIconProps = getServerStatusIconProps(serverName);
  const configDialogProps = getConfigDialogProps();
  const connectionState = statusIconProps?.serverStatus?.connectionState;
  const isInitializing = statusIconProps?.isInitializing ?? false;
  const statusDisplay = getStatusDisplay(
    serverName,
    statusIconProps?.serverStatus,
    isInitializing,
    liveServer.isConfigured,
  );
  /** A connected server's tools arrive with the (cold-cache) MCP tools fetch, and
   * the server is also briefly toolless while initializing — show a skeleton in
   * both cases instead of a misleading "no tools" message. */
  const toolsLoading =
    !hasTools && (mcpToolsLoading || isInitializing || connectionState === 'connecting');
  const isConnected = connectionState === 'connected' || liveServer.isConnected === true;
  const isReadyForAgent = liveServer.isReadyForAgent ?? isConnected;
  const isBusy = isInitializing || connectionState === 'connecting';

  /** Close + clear the OAuth dialog once the server is ready, and don't let it
   * reopen on its own if the connection later drops. No useEffect — adjust state
   * during render by comparing against the previous connection result. */
  if (prevReadyForAgent !== isReadyForAgent) {
    setPrevReadyForAgent(isReadyForAgent);
    if (isReadyForAgent) {
      setOauthOpen(false);
      setOauthUrl(null);
    }
  }

  /** Connecting from this dialog implies the user wants the server's tools:
   * once the connection settles and the tools arrive (query refetch for direct
   * connects, polling for OAuth), select them all — an effect because both
   * signals come from external systems, not from anything rendered here.
   *
   * A ready server can still have an empty instance catalog when discovery needs
   * user credentials or chat fields. Attach its runtime wildcard once loading
   * settles. Deferred init also covers connects behind the customUserVars dialog. */
  const initConnectionDeferred = isConnectionDeferred(serverName);
  const runtimeToolsAvailable =
    !hasTools && !toolsLoading && (isWildcardAttached || isReadyForAgent);
  const runtimeToolsMessage = isWildcardAttached
    ? 'com_ui_tools_mcp_runtime_tools'
    : 'com_ui_tools_mcp_runtime_tools_available';
  useEffect(() => {
    if (!autoSelectPending) {
      return;
    }
    if (!hasTools && (initConnectionDeferred || (!toolsLoading && isReadyForAgent))) {
      setAutoSelectPending(false);
      if (!isWildcardAttached) {
        toggleRuntimeTools(true);
      }
      return;
    }
    if (!isConnected || !hasTools) {
      return;
    }
    setAutoSelectPending(false);
    updateFormTools(tools.map((t) => t.tool_id));
  }, [
    autoSelectPending,
    initConnectionDeferred,
    toolsLoading,
    isReadyForAgent,
    isConnected,
    hasTools,
    tools,
    updateFormTools,
    toggleRuntimeTools,
    isWildcardAttached,
  ]);

  /** Connect inline from this first dialog. Servers with custom user variables are
   * routed to the config dialog (which sets the vars and initializes); others
   * connect directly. `autoOpenOAuth=false` surfaces the URL in our OAuth dialog
   * (continue / copy / QR) instead of the browser silently opening a tab. */
  const handleConnect = async (e: MouseEvent) => {
    setAutoSelectPending(true);
    if (statusIconProps != null && statusIconProps.hasCustomUserVars) {
      /** A stale deferred flag from an earlier attempt must not fire the
       * auto-attach effect while the config dialog is open — only this
       * attempt's outcome (recorded on save → initialize) counts. The direct
       * path below needs no reset: initializeServer clears it up front. */
      resetConnectionDeferred(serverName);
      statusIconProps.onConfigClick(e);
      return;
    }
    try {
      const res = await initializeServer(serverName, false);
      if (res == null || !res.success) {
        setAutoSelectPending(false);
        return;
      }
      if (res.oauthRequired && res.oauthUrl) {
        setOauthUrl(res.oauthUrl);
        setOauthOpen(true);
      }
    } catch {
      setAutoSelectPending(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      {item.description && (
        <p className="max-h-40 overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed text-text-secondary">
          {item.description}
        </p>
      )}

      <div className="flex flex-col">
        <div className="flex items-center justify-between rounded-xl border border-border-light bg-surface-secondary px-3 py-2.5">
          <div className="flex items-center gap-2">
            <span
              className={cn('size-2.5 rounded-full', statusDisplay.dotClass)}
              aria-hidden="true"
            />
            <span className="text-sm font-medium text-text-primary">
              {localize(statusDisplay.labelKey, { 0: serverName })}
            </span>
          </div>
          {isReadyForAgent && statusIconProps && <MCPServerStatusIcon {...statusIconProps} />}
        </div>

        {/* Connect collapses smoothly once ready. Its top spacing lives inside
         * the reveal so the parent's flex gap never leaves a hole when it's gone,
         * and the auto-height dialog follows the grid-rows tween in one motion. */}
        <div
          className={cn(
            'grid transition-[grid-template-rows] [transition-duration:var(--resize-dur)] [transition-timing-function:var(--resize-ease)] motion-reduce:transition-none',
            isReadyForAgent ? 'grid-rows-[0fr]' : 'grid-rows-[1fr]',
          )}
        >
          <div className="min-h-0 overflow-hidden">
            <Button
              type="button"
              variant="submit"
              className="mt-5 w-full gap-2"
              disabled={isBusy}
              tabIndex={isReadyForAgent ? -1 : undefined}
              aria-hidden={isReadyForAgent || undefined}
              onClick={handleConnect}
            >
              {isBusy && <Spinner className="size-4" />}
              {localize('com_nav_mcp_connect_server', { 0: serverName })}
            </Button>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex min-h-7 items-center justify-between">
          <span className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">
            {localize('com_ui_tools_mcp_tools_section')}
          </span>
          {(hasTools || runtimeToolsAvailable) && (
            <div className="flex items-center gap-0.5">
              {hasTools && deferredToolsEnabled && (
                <OptionToggle
                  icon={Clock}
                  size="md"
                  pressed={allDeferred}
                  label={localize(allDeferred ? 'com_ui_mcp_undefer_all' : 'com_ui_mcp_defer_all')}
                  activeBorderClass="border-series-4"
                  onToggle={() => toggleDeferAll(tools)}
                />
              )}
              {hasTools && programmaticToolsEnabled && (
                <OptionToggle
                  icon={Code2}
                  size="md"
                  pressed={allProgrammatic}
                  label={programmaticBulkLabel}
                  activeBorderClass="border-series-6"
                  tooltip={programmaticBulkTooltip}
                  disabled={!programmaticToolsAvailable && !allProgrammatic}
                  onToggle={() => toggleProgrammaticAll(tools)}
                />
              )}
              {hasTools && backgroundToolsEnabled && (
                <OptionToggle
                  icon={Zap}
                  size="md"
                  pressed={allBackground}
                  label={localize(
                    allBackground ? 'com_ui_mcp_unbackground_all' : 'com_ui_mcp_background_all',
                  )}
                  activeBorderClass="border-series-1"
                  onToggle={() => toggleBackgroundAll(tools)}
                />
              )}
              {hasTools && toolIntentsEnabled && (
                <OptionToggle
                  icon={Captions}
                  size="md"
                  pressed={allIntent}
                  disabled={intentEligibleTools.length === 0}
                  label={localize(allIntent ? 'com_ui_mcp_unintent_all' : 'com_ui_mcp_intent_all')}
                  activeBorderClass="border-series-3"
                  onToggle={() => toggleIntentAll(intentEligibleTools)}
                />
              )}
              {hasTools &&
                (deferredToolsEnabled ||
                  programmaticToolsEnabled ||
                  backgroundToolsEnabled ||
                  toolIntentsEnabled) && (
                  <span className="mx-1 h-4 w-px bg-border-light" aria-hidden="true" />
                )}
              <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-xs text-text-secondary">
                <Checkbox
                  checked={hasTools ? allSelected : isWildcardAttached}
                  onCheckedChange={(checked) =>
                    hasTools ? toggleAll(checked === true) : toggleRuntimeTools(checked === true)
                  }
                  aria-label={
                    (hasTools ? allSelected : isWildcardAttached)
                      ? localize('com_ui_tools_mcp_deselect_all')
                      : localize('com_ui_tools_mcp_select_all')
                  }
                  className="size-4 rounded border border-border-medium"
                />
                <span>
                  {(hasTools ? allSelected : isWildcardAttached)
                    ? localize('com_ui_tools_mcp_deselect_all')
                    : localize('com_ui_tools_mcp_select_all')}
                </span>
              </label>
            </div>
          )}
        </div>
        {/* Loading skeleton, tool list, and empty state share one slot and
         * cross-swap via stacked collapses so their differing heights morph
         * smoothly; the dialog's auto-height follows in a single motion. */}
        <div>
          <Collapse open={hasTools}>
            <div className="flex flex-col gap-1">
              {tools.map((tool) => (
                <MCPToolItem
                  key={tool.tool_id}
                  tool={tool}
                  isSelected={selectedTools.includes(tool.tool_id)}
                  isDeferred={deferredToolsEnabled && isToolDeferred(tool.tool_id)}
                  isProgrammatic={programmaticToolsEnabled && isToolProgrammatic(tool.tool_id)}
                  isBackground={backgroundToolsEnabled && isToolBackground(tool.tool_id)}
                  isIntent={
                    toolIntentsEnabled &&
                    isToolIntent(tool.tool_id) &&
                    !isToolProgrammaticOnly(tool.tool_id)
                  }
                  intentDisabled={isToolProgrammaticOnly(tool.tool_id)}
                  deferredToolsEnabled={deferredToolsEnabled}
                  programmaticToolsEnabled={programmaticToolsEnabled}
                  programmaticToolsAvailable={programmaticToolsAvailable}
                  backgroundToolsEnabled={backgroundToolsEnabled}
                  toolIntentsEnabled={toolIntentsEnabled}
                  onToggleSelect={() => toggleToolSelect(tool.tool_id)}
                  onToggleDefer={() => toggleToolDefer(tool.tool_id)}
                  onToggleProgrammatic={() => toggleToolProgrammatic(tool.tool_id)}
                  onToggleBackground={() => toggleToolBackground(tool.tool_id)}
                  onToggleIntent={() => toggleToolIntent(tool.tool_id)}
                />
              ))}
            </div>
          </Collapse>
          <Collapse open={!hasTools && toolsLoading}>
            <div className="flex flex-col gap-1" aria-busy="true" aria-live="polite">
              {['w-3/5', 'w-1/2', 'w-2/5'].map((width) => (
                <div key={width} className="flex items-center gap-2.5 rounded-lg px-2 py-2">
                  <Skeleton className="size-4 shrink-0 rounded" />
                  <Skeleton className={cn('h-4 rounded', width)} />
                </div>
              ))}
            </div>
          </Collapse>
          <Collapse open={!hasTools && !toolsLoading}>
            <p className="rounded-xl border border-dashed border-border-light p-3 text-center text-xs text-text-tertiary">
              {localize(runtimeToolsAvailable ? runtimeToolsMessage : 'com_ui_tools_mcp_no_tools')}
            </p>
          </Collapse>
        </div>
      </div>

      {configDialogProps && <MCPConfigDialog {...configDialogProps} />}
      <McpOAuthDialog
        open={oauthOpen && !isReadyForAgent}
        onOpenChange={setOauthOpen}
        serverName={serverName}
        oauthUrl={oauthUrl ?? getOAuthUrl(serverName) ?? ''}
        iconUrl={getIconForItem(item).iconUrl}
      />
    </div>
  );
}
