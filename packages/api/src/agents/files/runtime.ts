import { z } from 'zod';
import * as agentsSdk from '@librechat/agents';
import { tool } from '@librechat/agents/langchain/tools';
import type { GenericTool, LCTool, SubagentExecutionContext } from '@librechat/agents';
import type { RunFileSession } from './session';

export const LIST_RUN_FILES_TOOL = 'list_run_files';
export const PUBLISH_ARTIFACT_TOOL = 'publish_artifact';

/** Older SDKs cannot distinguish simultaneous copies of the same agent. */
export function isRunFileSharingSupported(): boolean {
  return (agentsSdk as { SUBAGENT_CONTEXT_VERSION?: number }).SUBAGENT_CONTEXT_VERSION === 1;
}

/** Every configured tool must execute through host authorization and artifact capture. */
export function eventOnlyRunFileTools(
  tools: GenericTool[] | undefined,
  definitions: readonly LCTool[],
): GenericTool[] | undefined {
  if (tools == null || tools.length === 0) return tools;
  const eventTools = new Set(definitions.map((definition) => definition.name));
  for (const candidate of tools) {
    if (
      candidate == null ||
      typeof candidate.name !== 'string' ||
      typeof candidate.invoke !== 'function' ||
      !eventTools.has(candidate.name)
    ) {
      throw new Error('Run file sharing requires host-dispatched tools with explicit definitions.');
    }
  }
  // The definitions bind the model; removing direct instances sends execution
  // through ON_TOOL_EXECUTE, including private workspace setup and capture.
  return [];
}

/** In-graph tools receive execution metadata stamped by the SDK's owning ToolNode. */
export function createRunFileTools(
  session: RunFileSession,
  agentId: string,
  runSignal: AbortSignal,
): GenericTool[] {
  const list = tool(
    async (_input, config) => {
      const context = config.metadata?.executionContext as SubagentExecutionContext | undefined;
      return JSON.stringify(await session.list(agentId, context, config.signal ?? runSignal));
    },
    {
      name: LIST_RUN_FILES_TOOL,
      description:
        'List the files this execution may read and its unpublished output artifact IDs. ' +
        'Use this to discover files published by other authorized agents during this run. ' +
        'Private output versions remain available across sandbox calls during this run. ' +
        'The same filename may have multiple artifact IDs, listed in creation order; publish the version you want to return when ready. ' +
        "When delegating a task that returns files, ask the producing subagent to publish its outputs before returning. A parent cannot publish a child's private artifact IDs.",
      schema: z.object({}).strict(),
    },
  );
  const publish = tool(
    async ({ artifact_id, recipient_agent_ids }, config) => {
      const context = config.metadata?.executionContext as SubagentExecutionContext | undefined;
      const file = await session.publish(
        agentId,
        context,
        artifact_id,
        recipient_agent_ids,
        config.signal ?? runSignal,
      );
      return JSON.stringify({ file_id: file.file_id, filename: file.filename });
    },
    {
      name: PUBLISH_ARTIFACT_TOOL,
      description:
        "Publish one of this execution's own output artifacts from list_run_files as a durable downloadable file for " +
        'the parent and user when ready. Each artifact ID selects an immutable output version, even after the working file changes. ' +
        'Outputs stay private until this succeeds. Optional sibling agent ' +
        'recipients must be authorized by the run sharing policy.',
      schema: z
        .object({
          artifact_id: z.string().min(1).describe('The artifact_id returned by list_run_files.'),
          recipient_agent_ids: z.array(z.string().min(1)).optional(),
        })
        .strict(),
    },
  );
  return [list, publish];
}
