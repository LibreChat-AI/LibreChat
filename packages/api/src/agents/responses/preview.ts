import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { logger } from '@librechat/data-schemas';
import { ContentTypes, StepTypes } from 'librechat-data-provider';
import type { StoredResponseRecord } from '@librechat/data-schemas';
import type { Agents } from 'librechat-data-provider';
import type { GenerationJobManagerClass } from '~/stream/GenerationJobManager';
import type { AgentExecutionEnrollment } from '../remote/lifecycle';
import { responseTenantId } from './scope';

export interface ResponsePreviewHandler {
  handle: (event: string, data: unknown) => void | Promise<void>;
}
export type ResponsePreviewJobs = Pick<
  GenerationJobManagerClass,
  'getResumeState' | 'setContentParts' | 'getJobStore' | 'getJob'
>;
const deltaSchema = z.object({
  delta: z.object({
    content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  }),
});

/** Publish only a bounded public text prefix, using the ordinary durable resume events. */
export function createResponsePreviewHandler(
  handler: ResponsePreviewHandler,
  deps: {
    jobs: ResponsePreviewJobs;
    record: StoredResponseRecord;
    execution: AgentExecutionEnrollment;
    maxChars: number;
  },
): ResponsePreviewHandler {
  const { jobs, record, execution, maxChars } = deps;
  if (
    record.generationCreatedAt !== execution.createdAt ||
    record.status !== 'in_progress' ||
    record.cancellationRequestedAt != null
  )
    return handler;
  const store = jobs.getJobStore();
  const stepId = `preview:${randomUUID()}`;
  const content: Agents.MessageContentComplex[] = [];
  let text = '';
  let initialized = false;
  let opened = false;
  let disabled = false;
  let saturated = false;
  let pending = Promise.resolve();
  function append(source: string): string {
    if (saturated) return '';
    let added = '';
    for (const point of source) {
      if (text.length + point.length > maxChars) {
        saturated = true;
        break;
      }
      text += point;
      added += point;
    }
    return added;
  }
  async function appendEvent(event: {
    event: string;
    data: Record<string, unknown>;
  }): Promise<boolean> {
    if (disabled || execution.signal.aborted) return false;
    const identity = execution.getPersistenceIdentity();
    const job = await jobs.getJob(record.responseId);
    if (
      !job ||
      job.status !== 'running' ||
      job.createdAt !== execution.createdAt ||
      job.metadata.providerExecutionId !== identity.providerExecutionId ||
      job.metadata.providerExecutionStartedId !== identity.providerExecutionId ||
      (identity.ownerId != null && job.metadata.providerExecutionOwnerId !== identity.ownerId) ||
      job.metadata.terminalPersistencePending === true ||
      execution.signal.aborted
    ) {
      disabled = true;
      return false;
    }
    const appended = await store.appendChunk(record.responseId, event, execution.createdAt);
    if (!appended) disabled = true;
    return appended;
  }
  async function publish(source: string): Promise<void> {
    if (disabled || saturated || execution.signal.aborted || text.length >= maxChars) return;
    if (!initialized) {
      const identity = execution.getPersistenceIdentity();
      const state = await jobs.getResumeState(record.responseId, execution.createdAt, {
        durableOnly: true,
        readIf: (job) =>
          job.status === 'running' &&
          job.userId === record.userId &&
          responseTenantId(job.tenantId) === responseTenantId(record.tenantId) &&
          job.agent_id === record.agentId &&
          job.endpoint === 'responses' &&
          job.responseMessageId === record.responseId &&
          job.conversationId === record.conversationId &&
          job.providerExecutionId === identity.providerExecutionId &&
          job.terminalPersistencePending !== true,
      });
      initialized = true;
      if (!state || execution.signal.aborted) {
        disabled = true;
        return;
      }
      for (const part of state.aggregatedContent ?? [])
        if (part.type === ContentTypes.TEXT && typeof part.text === 'string') append(part.text);
    }
    const delta = append(source);
    if (!delta || execution.signal.aborted) return;
    if (!opened) {
      if (
        !(await appendEvent({
          event: 'on_run_step',
          data: {
            id: stepId,
            index: 0,
            type: StepTypes.MESSAGE_CREATION,
            stepDetails: {
              type: StepTypes.MESSAGE_CREATION,
              message_creation: {
                message_id: record.responseId,
                content_type: ContentTypes.TEXT,
              },
            },
          },
        }))
      )
        return;
      opened = true;
    }
    if (execution.signal.aborted) return;
    if (
      !(await appendEvent({
        event: 'on_message_delta',
        data: { id: stepId, delta: { content: [{ type: ContentTypes.TEXT, text: delta }] } },
      }))
    )
      return;
    // Memory jobs have no chunk reconstruction. Redis readers use the durable events above.
    content[0] = { type: ContentTypes.TEXT, text };
    jobs.setContentParts(record.responseId, content, execution.createdAt);
  }
  return {
    async handle(event, data) {
      await handler.handle(event, data);
      if (event !== 'on_message_delta' || disabled || execution.signal.aborted) return;
      const parsed = deltaSchema.safeParse(data);
      if (!parsed.success) return;
      for (const part of parsed.data.delta.content) {
        if (part.type !== ContentTypes.TEXT || !part.text) continue;
        const value = part.text;
        pending = pending
          .then(() => publish(value))
          .catch(() => {
            disabled = true;
            logger.warn('[Responses] Live answer preview is unavailable');
          });
      }
      await pending;
    },
  };
}
