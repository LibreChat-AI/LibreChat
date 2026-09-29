import type * as t from 'librechat-data-provider';
import type { TPluginMap } from '~/common';
import { toolArtifactKey } from './artifacts';

/**
 * Identity for a file-backed attachment, or `null` for attachments (e.g. web
 * search) that aren't a file. Delegates to `toolArtifactKey` so this and the
 * artifact card's identity are the same rule — `toolArtifactKey` already
 * falls back `file_id` → `filepath` → `filename`, so an id-less attachment
 * keys by its unique per-session filepath rather than a display name that
 * two different files can share.
 */
export const fileIdentity = (attachment: t.TAttachment): string | null => {
  const file = attachment as Partial<t.TFile>;
  if (file.file_id != null || file.filepath != null) {
    return toolArtifactKey(file);
  }
  return null;
};

/** `updatedAt ?? createdAt`, parsed to ms; missing or unparseable → 0. */
const writeTimeMs = (attachment: t.TAttachment): number => {
  const file = attachment as Partial<t.TFile>;
  const value = file.updatedAt ?? file.createdAt;
  if (value == null) {
    return 0;
  }
  const ms = new Date(value as string | number | Date).getTime();
  return Number.isFinite(ms) ? ms : 0;
};

/**
 * Maps Attachments by `toolCallId` for quick lookup. Attachments are assumed
 * to belong to one message: when the same file repeats — e.g. a tool call
 * rewrites the file it produced earlier in the message — only the copy with
 * the newest write time survives (ties keep the higher array index), so a
 * message never shows the same file twice. Array order isn't chronological
 * (a background-run harvest can append an older copy after a newer
 * foreground rewrite), so only entries that will actually be grouped
 * (non-empty `toolCallId`) compete for survivorship; an unlinked duplicate
 * is dropped as always but never hides a linked copy. Non-file attachments
 * (no `file_id`/`filepath`) never collapse.
 */
export function mapAttachments(attachments: Array<t.TAttachment | null | undefined>) {
  const attachmentMap: Record<string, t.TAttachment[] | undefined> = {};

  const identities = attachments.map((attachment) =>
    attachment == null ? null : fileIdentity(attachment),
  );
  const survivorByIdentity = new Map<string, { index: number; time: number }>();
  attachments.forEach((attachment, index) => {
    if (attachment == null) {
      return;
    }
    const identity = identities[index];
    if (identity == null || !attachment.toolCallId) {
      return;
    }
    const time = writeTimeMs(attachment);
    const current = survivorByIdentity.get(identity);
    if (!current || time > current.time || (time === current.time && index > current.index)) {
      survivorByIdentity.set(identity, { index, time });
    }
  });

  attachments.forEach((attachment, index) => {
    if (attachment === null || attachment === undefined) {
      return;
    }
    const identity = identities[index];
    if (identity != null) {
      const survivor = survivorByIdentity.get(identity);
      if (survivor && survivor.index !== index) {
        return;
      }
    }
    const key = attachment.toolCallId || '';
    if (key.length === 0) {
      return;
    }

    if (!attachmentMap[key]) {
      attachmentMap[key] = [];
    }

    attachmentMap[key]?.push(attachment);
  });

  return attachmentMap;
}

/**
 * Filters a part's mapped attachments to its saved-agent and host run-step
 * owner. Provider tool-call ids repeat across agents and turns, so
 * `toolCallId` alone can route sibling output to the wrong card. Missing
 * attachment ownership remains a wildcard for legacy rows; a live part with
 * no step excludes step identities already owned by message siblings.
 */
export function filterAttachmentsForPart(
  attachments: t.TAttachment[] | undefined,
  partAgentId?: string,
  partStepId?: string,
  siblingStepIds?: ReadonlySet<string>,
): t.TAttachment[] | undefined {
  if (
    !attachments ||
    (partAgentId == null &&
      partStepId == null &&
      (siblingStepIds == null || siblingStepIds.size === 0))
  ) {
    return attachments;
  }
  const filtered = attachments.filter((attachment) => {
    const agentMatches =
      partAgentId == null || attachment.agentId == null || attachment.agentId === partAgentId;
    const stepMatches =
      partStepId != null
        ? attachment.stepId == null || attachment.stepId === partStepId
        : attachment.stepId == null || siblingStepIds?.has(attachment.stepId) !== true;
    return agentMatches && stepMatches;
  });
  return filtered.length === attachments.length ? attachments : filtered;
}

/** Maps Files by `file_id` for quick lookup */
export function mapFiles(files: t.TFile[]) {
  const fileMap = {} as Record<string, t.TFile>;

  for (const file of files) {
    fileMap[file.file_id] = file;
  }

  return fileMap;
}

/** Maps Assistants by `id` for quick lookup */
export function mapAssistants(assistants: t.Assistant[]) {
  const assistantMap = {} as Record<string, t.Assistant>;

  for (const assistant of assistants) {
    assistantMap[assistant.id] = assistant;
  }

  return assistantMap;
}

/** Maps Agents by `id` for quick lookup */
export function mapAgents(agents: t.Agent[]) {
  const agentsMap = {} as Record<string, t.Agent>;

  for (const agent of agents) {
    agentsMap[agent.id] = agent;
  }

  return agentsMap;
}

/** Maps Plugins by `pluginKey` for quick lookup */
export function mapPlugins(plugins: t.TPlugin[]): TPluginMap {
  return plugins.reduce((acc, plugin) => {
    acc[plugin.pluginKey] = plugin;
    return acc;
  }, {} as TPluginMap);
}

/** Transform query data to object with list and map fields */
export const selectPlugins = (
  data: t.TPlugin[] | undefined,
): {
  list: t.TPlugin[];
  map: TPluginMap;
} => {
  if (!data) {
    return {
      list: [],
      map: {},
    };
  }

  return {
    list: data,
    map: mapPlugins(data),
  };
};

/** Transform array to TPlugin values */
export function processPlugins(
  tools: (string | t.TPlugin)[],
  allPlugins?: TPluginMap,
): t.TPlugin[] {
  return tools
    .map((tool: string | t.TPlugin) => {
      if (typeof tool === 'string') {
        return allPlugins?.[tool];
      }
      return tool;
    })
    .filter((tool: t.TPlugin | undefined): tool is t.TPlugin => tool !== undefined);
}

export function mapToolCalls(toolCalls: t.ToolCallResults = []): {
  [key: string]: t.ToolCallResult[] | undefined;
} {
  return toolCalls.reduce(
    (acc, call) => {
      const key = `${call.messageId}_${call.partIndex ?? 0}_${call.blockIndex ?? 0}_${call.toolId}`;
      const array = acc[key] ?? [];
      array.push(call);
      acc[key] = array;

      return acc;
    },
    {} as { [key: string]: t.ToolCallResult[] | undefined },
  );
}
