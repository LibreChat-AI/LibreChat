import type { Agent, TTraceRecord, TTraceRecordRole } from 'librechat-data-provider';
import type { ActivityIndex, ToolCallPreview } from './preview';
import type { TranslationKeys } from '~/hooks';
import type { TraceNode } from './model';
import { parseToolName } from '~/utils/toolLabels';

type Localize = (key: TranslationKeys, values?: Record<string, string | number>) => string;

/** How a row reads to someone who has never seen a trace: the record in the chat's own words. */
export type RecordPresentation = {
  title: string;
  /** Where the work ran, beside the title: an MCP server, or the saved agent's model. */
  caption?: string;
  /** What the record produced or was given, taken from the chat's own message. */
  preview?: string;
  /** Set when `title` replaced the backend's name, which the technical details still show. */
  technicalName?: string;
  /** The saved agent the row stands for; `null` when the record names one this user cannot load. */
  agent?: Agent | null;
  /** The tools a row stands for, for their icons: a recorded tool, or an unrecorded round's calls. */
  toolNames?: string[];
  calls?: ToolCallView[];
  /** Where `calls` came from: the chat's own message, or only the names the trace recorded. */
  callsFrom?: 'conversation' | 'trace';
};

/** A call of an unrecorded tool round, named the way its chat tool card names it. */
export type ToolCallView = ToolCallPreview & Pick<RecordPresentation, 'title' | 'caption'>;

export type PresentationSources = {
  localize: Localize;
  activity: ActivityIndex;
  previewOf: (node: TraceNode) => string | undefined;
  agentOf: (agentId: string) => Agent | undefined;
  mcpServerNames?: readonly string[];
};

const ROLE_TITLES: Record<
  Exclude<TTraceRecordRole, 'agent' | 'tools' | 'plumbing'>,
  TranslationKeys
> = {
  run: 'com_ui_trace_role_run',
  model: 'com_ui_model',
  stepLabel: 'com_ui_trace_role_step_label',
  reasoningLabel: 'com_ui_trace_role_reasoning_label',
  phaseLabel: 'com_ui_trace_role_phase_label',
};

/** A tool's name as the chat's tool cards give it: a built-in's friendly name, or an MCP tool beside its server. */
export function presentTool(
  name: string,
  { localize, mcpServerNames }: Pick<PresentationSources, 'localize' | 'mcpServerNames'>,
): Pick<RecordPresentation, 'title' | 'caption'> {
  const parsed = parseToolName(name, mcpServerNames);
  if (parsed.friendlyKey != null) {
    return { title: localize(parsed.friendlyKey) };
  }
  return { title: parsed.toolName, caption: parsed.mcpServer || undefined };
}

function presentToolRound(record: TTraceRecord, sources: PresentationSources): RecordPresentation {
  const { localize, activity } = sources;
  /** The trace's own names say what ran; the chat's message, when it matches, adds what was sent and returned. */
  const matched = activity.calls.get(record.id);
  const calls = matched ?? record.tools?.map((name) => ({ name, args: '' })) ?? [];
  const callsFrom = matched != null ? ('conversation' as const) : ('trace' as const);
  const technicalName = record.name;
  if (calls.length === 0) {
    return { title: localize('com_ui_trace_role_tools'), technicalName };
  }
  const views = calls.map((call) => ({ ...call, ...presentTool(call.name, sources) }));
  const toolNames = calls.map((call) => call.name);
  if (views.length === 1) {
    const [{ title, caption, args }] = views;
    return {
      title,
      caption,
      preview: args || undefined,
      technicalName,
      toolNames,
      calls: views,
      callsFrom,
    };
  }
  const titles = [...new Set(views.map((view) => view.title))];
  return {
    title: localize('com_ui_trace_role_tools_count', { count: calls.length }),
    preview: titles.join(', '),
    technicalName,
    toolNames,
    calls: views,
    callsFrom,
  };
}

export function presentRecord(node: TraceNode, sources: PresentationSources): RecordPresentation {
  const { record } = node;
  const { localize, activity, previewOf, agentOf } = sources;
  if (record.role === 'agent' && record.agentId != null) {
    const agent = agentOf(record.agentId) ?? null;
    return {
      title: agent?.name || localize('com_ui_agent'),
      caption: agent?.model ?? undefined,
      technicalName: record.name,
      agent,
    };
  }
  if (record.role === 'tools') {
    return presentToolRound(record, sources);
  }
  /** A wrapper only frames a model call; every span as recorded is where it shows, under its own name. */
  if (record.role != null && record.role !== 'agent' && record.role !== 'plumbing') {
    const named = record.role === 'model' && record.origin === 'title';
    return {
      title: localize(named ? 'com_ui_trace_role_title' : ROLE_TITLES[record.role]),
      preview: activity.labels.get(record.id) ?? previewOf(node),
      technicalName: record.name,
    };
  }
  if (record.kind === 'tool') {
    return {
      ...presentTool(record.name, sources),
      preview: previewOf(node),
      toolNames: [record.name],
    };
  }
  return { title: record.name, preview: previewOf(node) };
}
