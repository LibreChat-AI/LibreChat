import { createHash, randomUUID } from 'node:crypto';
import { tool } from '@librechat/agents/langchain/tools';
import { setTimeout as delay } from 'node:timers/promises';
import {
  mediaToolGenerateSchema,
  mediaToolStatusSchema,
  mediaToolArtifactSchema,
  PermissionTypes,
  Permissions,
} from 'librechat-data-provider';
import type { MediaAsset, MediaJob, MediaToolArtifact, TPlugin } from 'librechat-data-provider';
import type { DynamicStructuredTool } from '@librechat/agents/langchain/tools';
import type { MediaMethods, AppConfig } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import type { MediaContext, MediaServices } from '~/media/service';
import type { CheckAccessParams } from '~/middleware/access';
import { checkAccessWithRequestCache } from '~/middleware/access';
import { assertMediaAccess } from '~/media/service';
import { MediaServiceError } from '~/media/errors';
import { mediaToolkit } from './toolkits/media';

export interface MediaToolDependencies {
  services: MediaServices;
  repository: Pick<MediaMethods, 'getMediaJobView'>;
  resolveContext(): Promise<MediaContext>;
  admitGeneration(): Promise<void>;
  signal?: AbortSignal;
  now(): number;
}

function output(job: MediaJob): [string, MediaToolArtifact] {
  const media = {
    jobId: job.jobId,
    threadId: job.threadId,
    operation: job.operation,
    phase: job.phase,
  };
  const files = job.outputs.flatMap((part) =>
    part.kind !== 'text' && part.state === 'ready' && part.asset ? [part.asset] : [],
  );
  const artifact = { media, files, ...(job.error ? { error: job.error } : {}) };
  return [
    JSON.stringify({
      media,
      files: files.map(({ file_id, filename, type }) => ({ file_id, filename, type })),
      ...(job.error ? { error: job.error } : {}),
    }),
    artifact,
  ];
}

/** Reads only owner-scoped, public job projections; no storage bytes are copied into tool output. */
export function createMediaTools(
  deps: MediaToolDependencies,
): readonly [
  DynamicStructuredTool<typeof mediaToolGenerateSchema>,
  DynamicStructuredTool<typeof mediaToolStatusSchema>,
] {
  const fallbackRunId = randomUUID();
  async function context(create: boolean): Promise<MediaContext> {
    const current = await deps.resolveContext();
    assertMediaAccess(current, create);
    if (!current.config.surfaces.tools) {
      throw new MediaServiceError('disabled', 403, 'Media agent tools are disabled.');
    }
    return { ...current, admitGeneration: deps.admitGeneration };
  }
  async function readJob(jobId: string, current: MediaContext): Promise<MediaJob> {
    const job = await deps.repository.getMediaJobView(current.scope, jobId);
    if (!job) throw new MediaServiceError('not_found', 404, 'Media generation is unavailable.');
    return job;
  }
  const generate = tool(
    async (input, config) => {
      const signals = [deps.signal, config?.signal].filter(
        (item): item is AbortSignal => item != null,
      );
      const signal = signals.length ? AbortSignal.any(signals) : undefined;
      signal?.throwIfAborted();
      const current = await context(true);
      const catalog = await deps.services.queries.catalog(current);
      signal?.throwIfAborted();
      const clientRequestId = createHash('sha256')
        .update(
          JSON.stringify([
            config?.metadata?.thread_id ?? fallbackRunId,
            config?.metadata?.run_id ?? fallbackRunId,
            config?.toolCall?.id ?? randomUUID(),
          ]),
        )
        .digest('hex');
      const receipt = await deps.services.commands.submit(
        {
          operation: input.operation,
          prompt: input.prompt,
          inputs: input.inputs,
          parameters: input.parameters,
          schemaVersion: 1,
          clientRequestId,
          selection: {
            connectionId: input.connectionId,
            modelId: input.modelId,
            providerTag: input.providerTag,
            catalogVersion: catalog.version,
          },
        },
        current,
      );
      if (receipt.phase === 'rejected') {
        throw new MediaServiceError(receipt.error.code, 422, 'Media generation was rejected.');
      }
      try {
        signal?.throwIfAborted();
        let job = await readJob(receipt.jobId, current);
        if (input.operation === 'video.generate') return output(job);
        const deadline = deps.now() + current.config.tools.imageTimeoutMs;
        while (
          ['queued', 'submitting', 'running', 'ingesting', 'reconciling'].includes(job.phase)
        ) {
          if (deps.now() >= deadline) break;
          await delay(
            Math.min(current.config.tools.pollIntervalMs, deadline - deps.now()),
            undefined,
            { signal },
          );
          job = await readJob(receipt.jobId, current);
        }
        return output(job);
      } catch (error) {
        if (signal?.aborted) {
          await deps.services.commands.cancel(receipt.jobId, current);
          signal.throwIfAborted();
        }
        throw error;
      }
    },
    { ...mediaToolkit.media_generate, schema: mediaToolGenerateSchema },
  );
  const status = tool(
    async ({ jobId }) => {
      const current = await context(false);
      if (jobId) return output(await readJob(jobId, current));
      const catalog = await deps.services.queries.catalog(current);
      return [JSON.stringify({ catalog }), {}];
    },
    { ...mediaToolkit.media_status, schema: mediaToolStatusSchema },
  );
  return [generate, status] as const;
}

export function loadMediaTools({
  runtime,
  request,
  signal,
}: {
  runtime?: { tools(request: Request, signal?: AbortSignal): ReturnType<typeof createMediaTools> };
  request: Request;
  signal?: AbortSignal;
}): ReturnType<typeof createMediaTools> {
  if (!runtime) throw new MediaServiceError('disabled', 403, 'Media agent tools are disabled.');
  return runtime.tools(request, signal);
}

type MediaToolAttachment = MediaAsset & {
  messageId?: string;
  conversationId?: string;
  toolCallId?: string;
  agentId?: string;
  stepId?: string;
};

/** Builtin media tools return authorized File references; attachments must not re-save their bytes. */
export function collectMediaToolAttachments({
  output,
  metadata,
  response,
  streamId,
  emit,
}: {
  output: { name?: string; tool_call_id?: string; artifact?: unknown };
  metadata: {
    run_id?: string;
    thread_id?: string;
    agentId?: string;
    executingAgentId?: string;
    agent_id?: string;
    stepId?: string;
  };
  response: Pick<Response, 'headersSent' | 'writableEnded'>;
  streamId?: string | null;
  emit(attachment: MediaToolAttachment): void | Promise<void>;
}): Promise<MediaToolAttachment>[] {
  if (output.name !== 'media_generate' && output.name !== 'media_status') return [];
  const parsed = mediaToolArtifactSchema.safeParse(output.artifact);
  if (!parsed.success) return [];
  return parsed.data.files.map(async (file) => {
    const attachment = {
      ...file,
      messageId: metadata.run_id,
      conversationId: metadata.thread_id,
      toolCallId: output.tool_call_id,
      agentId: metadata.executingAgentId ?? metadata.agentId ?? metadata.agent_id,
      stepId: metadata.stepId,
    };
    if (!response.writableEnded && (streamId || response.headersSent)) await emit(attachment);
    return attachment;
  });
}

export async function filterMediaToolPlugins(
  plugins: TPlugin[],
  {
    appConfig,
    request,
    getRoleByName,
  }: {
    appConfig: AppConfig;
    request: Request;
    getRoleByName: CheckAccessParams['getRoleByName'];
  },
): Promise<TPlugin[]> {
  if (!plugins.some((plugin) => plugin.pluginKey === 'media_generate')) return plugins;
  const configured = appConfig.media?.enabled && appConfig.media.surfaces.tools;
  const allowed =
    configured &&
    (await checkAccessWithRequestCache({
      req: request,
      user: request.user as CheckAccessParams['user'],
      permissionType: PermissionTypes.MEDIA,
      permissions: [Permissions.USE, Permissions.CREATE],
      getRoleByName,
    }));
  return allowed ? plugins : plugins.filter((plugin) => plugin.pluginKey !== 'media_generate');
}
