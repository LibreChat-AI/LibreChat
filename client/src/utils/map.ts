import type * as t from 'librechat-data-provider';

/** Maps Attachments by `toolCallId` for quick lookup */
export function mapAttachments(attachments: Array<t.TAttachment | null | undefined>) {
  const attachmentMap: Record<string, t.TAttachment[] | undefined> = {};

  for (const attachment of attachments) {
    if (attachment === null || attachment === undefined) {
      continue;
    }
    const key = attachment.toolCallId || '';
    if (key.length === 0) {
      continue;
    }

    if (!attachmentMap[key]) {
      attachmentMap[key] = [];
    }

    attachmentMap[key]?.push(attachment);
  }

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
