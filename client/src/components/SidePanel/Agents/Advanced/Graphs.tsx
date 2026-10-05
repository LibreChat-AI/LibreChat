import { useContext, useState, useMemo } from 'react';
import { Workflow, Plus, Pencil, X } from 'lucide-react';
import { useFormContext, useWatch } from 'react-hook-form';
import {
  Button,
  Input,
  Label,
  Textarea,
  Checkbox,
  Switch,
  ControlCombobox,
} from '@librechat/client';
import {
  graphSubagentSchema,
  getSubagentGraphMemberCount,
  MAX_SUBAGENT_GRAPH_NODES,
  AgentCapabilities,
  EModelEndpoint,
  Tools,
  isSubagentGraphsEnabled,
  MAX_SUBAGENTS,
  MAX_GRAPH_SUBAGENT_MEMBERS,
} from 'librechat-data-provider';
import type { AgentSubagentGraph, AgentSubagentGraphEdge, Agent } from 'librechat-data-provider';
import type { AgentForm, OptionWithIcon } from '~/common';
import {
  collectReachableAgents,
  findExecutionEnvironment,
} from '~/hooks/Agents/useCodeApprovalMode';
import { AgentPickerPortalContext, AddAgentSelect, useSelectableAgents } from './AgentList';
import { useAgentPanelContext, useAgentsMapContext } from '~/Providers';
import OrchestrationPattern from './OrchestrationPattern';
import { useLocalize } from '~/hooks';
import { CountPill } from './ui';

interface Draft {
  index: number | null;
  graph: AgentSubagentGraph;
}
const endpoints = (value: string | string[]): string[] => (Array.isArray(value) ? value : [value]);

export default function Graphs({ currentAgentId }: { currentAgentId: string }) {
  const localize = useLocalize();
  const { agentsConfig } = useAgentPanelContext();
  const agentsMap = useAgentsMapContext();
  const { control, getValues, setValue } = useFormContext<AgentForm>();
  const subagents = useWatch({ control, name: 'subagents' });
  const graphs = subagents?.graphs ?? [];
  const enabled = isSubagentGraphsEnabled(subagents, agentsConfig?.capabilities);
  const maximum = agentsConfig?.maxSubagents ?? MAX_SUBAGENTS;
  const { options, getAgent } = useSelectableAgents({ currentAgentId });
  const portalElement = useContext(AgentPickerPortalContext) ?? undefined;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [invalid, setInvalid] = useState(false);
  const allOptions: OptionWithIcon[] = [
    { value: '__current_agent__', label: localize('com_ui_agent_graphs_self') },
    ...options,
  ];
  const nameOf = (id: string) =>
    id === currentAgentId || id === ''
      ? localize('com_ui_agent_graphs_self')
      : (getAgent(id)?.name ?? id);
  const [codeEnabled, statefulSessions, codeEnvironmentId, codeEnvironmentIds, agentIds, edges] =
    useWatch({
      control,
      name: [
        'execute_code',
        'stateful_code_sessions',
        'code_environment_id',
        'code_environment_ids',
        'agent_ids',
        'edges',
      ],
    });
  const reachable = useMemo(() => {
    const currentAgent: Agent = {
      id: currentAgentId,
      name: null,
      description: null,
      avatar: null,
      created_at: 0,
      provider: EModelEndpoint.openAI,
      model: null,
      model_parameters: getValues('model_parameters'),
      tools: codeEnabled ? [Tools.execute_code] : [],
      stateful_code_sessions: statefulSessions,
      code_environment_id: codeEnvironmentId,
      code_environment_ids: codeEnvironmentIds,
      agent_ids: agentIds,
      edges,
      subagents,
    };
    return collectReachableAgents(
      [currentAgent],
      agentsMap,
      [currentAgentId],
      agentsConfig?.capabilities,
    );
  }, [
    currentAgentId,
    codeEnabled,
    statefulSessions,
    codeEnvironmentId,
    codeEnvironmentIds,
    agentIds,
    edges,
    subagents,
    agentsMap,
    agentsConfig?.capabilities,
    getValues,
  ]);
  const attachedCode =
    agentsConfig?.capabilities.includes(AgentCapabilities.stateful_code_sessions) &&
    reachable.agents.some(
      (agent) =>
        agent.stateful_code_sessions === true &&
        agent.tools?.includes(Tools.execute_code) &&
        findExecutionEnvironment(agent, agentsConfig?.statefulCodeSessions?.environments)?.type ===
          'attached',
    );
  const approvalEnabled =
    agentsConfig?.toolApproval?.enabled === true ||
    (agentsConfig?.toolApproval?.enabled !== false && attachedCode);
  const write = (next: AgentSubagentGraph[], active?: boolean) => {
    const value = getValues('subagents');
    setValue(
      'subagents',
      {
        ...value,
        enabled: value?.enabled ?? false,
        allowSelf: value?.allowSelf ?? true,
        agent_ids: value?.agent_ids ?? [],
        ...(active === undefined ? {} : { graphsEnabled: active }),
        graphs: next,
      },
      { shouldDirty: true },
    );
  };
  const update = (patch: Partial<AgentSubagentGraph>) => {
    if (!draft) return;
    setDraft({ ...draft, graph: { ...draft.graph, ...patch } });
    setInvalid(false);
  };
  const addMember = (id: string) => {
    if (
      !draft ||
      draft.graph.agent_ids.includes(id) ||
      draft.graph.agent_ids.length >= MAX_GRAPH_SUBAGENT_MEMBERS
    )
      return;
    update({
      agent_ids: [...draft.graph.agent_ids, id],
      ...(draft.graph.agent_ids.length === 0 ? { entry_agent_id: id, result_agent_id: id } : {}),
    });
  };
  const save = () => {
    if (!draft) return;
    const parsed = graphSubagentSchema.safeParse(draft.graph);
    const reserved = new Set([
      'self',
      ...(subagents?.agent_ids ?? []),
      ...graphs.filter((_, index) => index !== draft.index).map((graph) => graph.type),
    ]);
    if (!parsed.success || reserved.has(draft.graph.type.trim())) {
      setInvalid(true);
      return;
    }
    const next = graphs.slice();
    if (draft.index === null) {
      if (graphs.length >= maximum) {
        setInvalid(true);
        return;
      }
      next.push(parsed.data);
    } else next[draft.index] = parsed.data;
    if (getSubagentGraphMemberCount({ ...subagents, graphs: next }) > MAX_SUBAGENT_GRAPH_NODES) {
      setInvalid(true);
      return;
    }
    write(next, draft.index === null ? true : undefined);
    setDraft(null);
  };
  const graph = draft?.graph;
  const memberOptions = graph?.agent_ids.map((id) => ({ value: id, label: nameOf(id) })) ?? [];
  const changeEdge = (index: number, patch: Partial<AgentSubagentGraphEdge>) => {
    if (!graph) return;
    update({ edges: graph.edges.map((edge, i) => (i === index ? { ...edge, ...patch } : edge)) });
  };

  return (
    <OrchestrationPattern
      icon={<Workflow className="h-4 w-4" aria-hidden="true" />}
      title={localize('com_ui_agent_graphs')}
      subtitle={localize('com_ui_agent_graphs_hint')}
      beta
      info={<p className="text-text-secondary text-sm">{localize('com_ui_agent_graphs_info')}</p>}
      trailing={
        <CountPill>
          {graphs.length} / {maximum}
        </CountPill>
      }
    >
      {approvalEnabled && (
        <p role="note" className="text-text-warning text-sm">
          {localize('com_ui_agent_graphs_approvals')}
        </p>
      )}
      {graphs.length > 0 && (
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="subagent-graphs-enabled">{localize('com_ui_agent_graphs_enable')}</Label>
          <Switch
            id="subagent-graphs-enabled"
            aria-label={localize('com_ui_agent_graphs_enable')}
            checked={enabled}
            onCheckedChange={(active) => write(graphs, active)}
          />
        </div>
      )}
      {draft === null && (
        <>
          {graphs.length === 0 && (
            <p className="text-text-secondary text-sm">{localize('com_ui_agent_graphs_empty')}</p>
          )}
          <ul className="flex flex-col gap-2">
            {graphs.map((team, index) => (
              <li key={team.type} className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-text-primary truncate text-sm font-medium">{team.name}</p>
                  <p className="text-text-secondary text-xs">
                    {team.agent_ids.map(nameOf).join(' → ')}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={localize('com_ui_agent_graphs_edit', { 0: team.name })}
                  onClick={() => {
                    setDraft({ index, graph: { ...team } });
                    setInvalid(false);
                  }}
                >
                  <Pencil className="h-4 w-4" aria-hidden="true" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={localize('com_ui_agent_graphs_remove', { 0: team.name })}
                  onClick={() =>
                    write(
                      graphs.filter((_, i) => i !== index),
                      undefined,
                    )
                  }
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
          <Button
            type="button"
            variant="outline"
            disabled={graphs.length >= maximum}
            onClick={() => {
              setDraft({
                index: null,
                graph: {
                  type: '',
                  name: '',
                  description: '',
                  agent_ids: [],
                  edges: [],
                  entry_agent_id: '',
                  result_agent_id: '',
                },
              });
              setInvalid(false);
            }}
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            {localize('com_ui_agent_graphs_add')}
          </Button>
        </>
      )}
      {graph && (
        <div className="flex flex-col gap-4">
          <div>
            <Label htmlFor="graph-name">{localize('com_ui_agent_graphs_name')}</Label>
            <Input
              id="graph-name"
              value={graph.name}
              onChange={(event) => update({ name: event.target.value })}
            />
          </div>
          <div>
            <Label htmlFor="graph-type">{localize('com_ui_agent_graphs_type')}</Label>
            <Input
              id="graph-type"
              value={graph.type}
              onChange={(event) => update({ type: event.target.value })}
            />
          </div>
          <div>
            <Label htmlFor="graph-description">{localize('com_ui_agent_graphs_description')}</Label>
            <Textarea
              id="graph-description"
              value={graph.description}
              onChange={(event) => update({ description: event.target.value })}
            />
          </div>
          <section
            aria-label={localize('com_ui_agent_graphs_members')}
            className="flex flex-col gap-2"
          >
            <Label>{localize('com_ui_agent_graphs_members')}</Label>
            {graph.agent_ids.map((id) => (
              <div key={id} className="flex items-center justify-between gap-2">
                <span className="text-sm">{nameOf(id)}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={localize('com_ui_agent_subagents_remove', { 0: nameOf(id) })}
                  onClick={() =>
                    update({
                      agent_ids: graph.agent_ids.filter((member) => member !== id),
                      edges: graph.edges.filter(
                        (edge) => ![...endpoints(edge.from), ...endpoints(edge.to)].includes(id),
                      ),
                    })
                  }
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </Button>
              </div>
            ))}
            {graph.agent_ids.length < MAX_GRAPH_SUBAGENT_MEMBERS && (
              <AddAgentSelect
                options={allOptions.filter(
                  (option) =>
                    !graph.agent_ids.includes(
                      option.value === '__current_agent__'
                        ? currentAgentId || ''
                        : String(option.value),
                    ),
                )}
                onSelect={(id) => addMember(id === '__current_agent__' ? currentAgentId || '' : id)}
                placeholder={localize('com_ui_agent_graphs_add_member')}
                ariaLabel={localize('com_ui_agent_graphs_add_member')}
              />
            )}
          </section>
          {(['entry_agent_id', 'result_agent_id'] as const).map((key) => (
            <div key={key}>
              <Label>
                {localize(
                  key === 'entry_agent_id'
                    ? 'com_ui_agent_graphs_entry'
                    : 'com_ui_agent_graphs_result',
                )}
              </Label>
              <ControlCombobox
                isCollapsed={false}
                ariaLabel={localize(
                  key === 'entry_agent_id'
                    ? 'com_ui_agent_graphs_entry'
                    : 'com_ui_agent_graphs_result',
                )}
                selectedValue={graph[key]}
                displayValue={graph.agent_ids.includes(graph[key]) ? nameOf(graph[key]) : ''}
                items={memberOptions}
                setValue={(id) => update({ [key]: id })}
                portalElement={portalElement}
                searchPlaceholder={localize('com_ui_agent_var', { 0: localize('com_ui_search') })}
              />
            </div>
          ))}
          <section
            aria-label={localize('com_ui_agent_graphs_edges')}
            className="flex flex-col gap-3"
          >
            <Label>{localize('com_ui_agent_graphs_edges')}</Label>
            {graph.edges.map((edge, index) => (
              <div
                key={index}
                className="border-border-light flex flex-col gap-2 rounded-lg border p-3"
              >
                {(['from', 'to'] as const).map((key) => (
                  <fieldset key={key} className="flex flex-col gap-1">
                    <legend className="text-text-secondary text-sm">
                      {localize(
                        key === 'from' ? 'com_ui_agent_graphs_from' : 'com_ui_agent_graphs_to',
                      )}
                    </legend>
                    {graph.agent_ids.map((id) => (
                      <label key={id} className="flex items-center gap-2 text-sm">
                        <Checkbox
                          aria-label={nameOf(id)}
                          checked={endpoints(edge[key]).includes(id)}
                          onCheckedChange={(checked) => {
                            const ids = endpoints(edge[key]).filter((value) => value !== id);
                            if (checked) ids.push(id);
                            changeEdge(index, { [key]: ids.length === 1 ? ids[0] : ids });
                          }}
                        />
                        {nameOf(id)}
                      </label>
                    ))}
                  </fieldset>
                ))}
                <Label htmlFor={`graph-edge-prompt-${index}`}>
                  {localize('com_ui_agent_graphs_prompt')}
                </Label>
                <Textarea
                  id={`graph-edge-prompt-${index}`}
                  value={edge.prompt ?? ''}
                  onChange={(event) =>
                    changeEdge(index, {
                      prompt: event.target.value || undefined,
                      ...(!event.target.value && { excludeResults: undefined }),
                    })
                  }
                />
                {edge.prompt && (
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      aria-label={localize('com_ui_agent_graphs_exclude')}
                      checked={edge.excludeResults === true}
                      onCheckedChange={(checked) =>
                        changeEdge(index, { excludeResults: checked === true ? true : undefined })
                      }
                    />
                    {localize('com_ui_agent_graphs_exclude')}
                  </label>
                )}
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => update({ edges: graph.edges.filter((_, i) => i !== index) })}
                >
                  {localize('com_ui_agent_graphs_remove_edge')}
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              disabled={graph.agent_ids.length < 2}
              onClick={() =>
                update({ edges: [...graph.edges, { from: [], to: [], edgeType: 'direct' }] })
              }
            >
              {localize('com_ui_agent_graphs_add_edge')}
            </Button>
          </section>
          {invalid && (
            <p role="alert" className="text-text-destructive text-sm">
              {localize('com_ui_agent_graphs_invalid')}
            </p>
          )}
          <div className="flex gap-2">
            <Button type="button" onClick={save}>
              {localize('com_ui_agent_graphs_save')}
            </Button>
            <Button type="button" variant="outline" onClick={() => setDraft(null)}>
              {localize('com_ui_cancel')}
            </Button>
          </div>
        </div>
      )}
    </OrchestrationPattern>
  );
}
