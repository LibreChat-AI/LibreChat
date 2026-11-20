import type * as t from 'librechat-data-provider';

export { mapAttachments, filterAttachmentsForPart } from '@librechat/chat';

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
