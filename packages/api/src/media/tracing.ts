import { randomUUID } from 'node:crypto';
import { AIMessage } from '@langchain/core/messages';
import { traceModelInvocation } from '@librechat/agents';
import type { Callbacks } from '@langchain/core/callbacks/manager';
import type { ModelInvocationTrace } from '@librechat/agents';
import type { ChatGeneration } from '@langchain/core/outputs';
import type { UsageMetadata } from '~/stream/interfaces/IJobStore';
import type { MediaContext } from './context';
import { buildLangfuseConfig } from '~/langfuse/config';

export type MediaModelTraceInput = {
  context: MediaContext;
  jobId: string;
  threadId: string;
  kind: 'title' | 'submission';
  model: string;
  provider: string;
};
export interface MediaModelTracer {
  run<T>(
    input: MediaModelTraceInput,
    work: (callbacks?: Callbacks) => Promise<T>,
    usage: (result: T) => UsageMetadata | undefined,
  ): Promise<T>;
}
/** Titles use model callbacks; external provider calls supply a redacted SDK result projection. */
export function createMediaModelTracer(
  deps: {
    trace?: typeof traceModelInvocation;
    config?: typeof buildLangfuseConfig;
  } = {},
): MediaModelTracer {
  return {
    async run(input, work, usage) {
      const traceIdSeed = input.kind === 'title' ? `title-${input.jobId}` : input.jobId;
      let params: ModelInvocationTrace;
      try {
        params = {
          langfuse: (deps.config ?? buildLangfuseConfig)({
            appConfig: input.context.appConfig,
            user: input.context.user,
            tenantId: input.context.scope.tenantId ?? undefined,
            runId: traceIdSeed,
            traceContext: {
              conversationId: input.threadId,
              provider: input.provider,
              model: input.model,
            },
          }),
          runId: randomUUID(),
          traceIdSeed,
          sessionId: input.threadId,
          userId: input.context.scope.ownerId,
          provider: input.provider,
          model: input.model,
          tags: ['librechat', 'media', input.kind],
          traceName: `media.${input.kind}`,
          traceMetadata: { 'librechat.media.job.id': input.jobId },
        };
      } catch {
        return work();
      }
      const trace = deps.trace ?? traceModelInvocation;
      if (input.kind === 'title') return trace(params, work);
      return trace(params, work, (result) => {
        const measured = usage(result);
        const inputTokens = measured?.input_tokens ?? 0;
        const outputTokens = measured?.output_tokens ?? 0;
        const generation: ChatGeneration = {
          text: '[Media output content omitted]',
          message: new AIMessage({
            content: '[Media output content omitted]',
            ...(measured
              ? {
                  usage_metadata: {
                    ...measured,
                    input_tokens: inputTokens,
                    output_tokens: outputTokens,
                    total_tokens: measured.total_tokens ?? inputTokens + outputTokens,
                  },
                }
              : {}),
          }),
        };
        return { generations: [[generation]] };
      });
    },
  };
}
