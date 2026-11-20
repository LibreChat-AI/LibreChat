import { performance } from 'node:perf_hooks';
import { logger } from '@librechat/data-schemas';
import { getSafeErrorMetadata, isOwnedAbortError } from '~/utils/errors';

export interface ToolExecutionIdentity {
  toolName: string;
  toolCallId: string;
  stepId?: string;
  agentId?: string;
  runId?: string;
  conversationId?: string;
  userId?: string;
  tenantId?: string;
  parentToolCallId?: string;
  backgroundTaskId?: string;
  rootRunId?: string;
  parentRunId?: string;
  subagentRunId?: string;
  mode: 'foreground' | 'background' | 'programmatic';
}

function isFailedResult(result: unknown): boolean {
  try {
    return (
      result != null &&
      typeof result === 'object' &&
      (('status' in result && result.status === 'error') ||
        ('isError' in result && result.isError === true))
    );
  } catch {
    return false;
  }
}

interface ToolExecutionOptions {
  signal?: AbortSignal;
  getAbortSource?: () => 'manual' | 'timeout' | 'shutdown' | undefined;
}

/** Logs execution, not stream delivery. Never retains or serializes tool payloads. */
export async function observeToolExecution<T>(
  identity: ToolExecutionIdentity,
  execute: () => Promise<T>,
  { signal, getAbortSource }: ToolExecutionOptions = {},
): Promise<T> {
  const attributes: Record<string, string | number> = {
    'gen_ai.tool.name': identity.toolName,
    'gen_ai.tool.call.id': identity.toolCallId,
    'librechat.tool.execution.mode': identity.mode,
  };
  const optional = {
    'librechat.tool.step.id': identity.stepId,
    'librechat.agent.id': identity.agentId,
    'librechat.run.id': identity.runId,
    'librechat.conversation.id': identity.conversationId,
    'enduser.id': identity.userId,
    'librechat.tenant.id': identity.tenantId,
    'librechat.tool.parent_call.id': identity.parentToolCallId,
    'librechat.tool.background_task.id': identity.backgroundTaskId,
    'librechat.run.root.id': identity.rootRunId,
    'librechat.run.parent.id': identity.parentRunId,
    'librechat.subagent.run.id': identity.subagentRunId,
  };
  for (const [key, value] of Object.entries(optional)) {
    if (typeof value === 'string' && value.length > 0) {
      attributes[key] = value;
    }
  }
  const startedAt = performance.now();
  const emit = (event: string, status: string, error?: unknown): void => {
    try {
      const record = {
        ...attributes,
        'event.name': event,
        'librechat.tool.status': status,
        ...(status !== 'running' && {
          'librechat.tool.duration_ms': performance.now() - startedAt,
        }),
        ...(error !== undefined && { 'error.type': getSafeErrorMetadata(error).type }),
      };
      if (status === 'error') {
        logger.warn(event, record);
      } else {
        logger.info(event, record);
      }
    } catch {
      // Telemetry must not alter execution or replace its result/error.
    }
  };
  emit('librechat.tool.execution.started', 'running');
  try {
    const result = await execute();
    emit('librechat.tool.execution.completed', isFailedResult(result) ? 'error' : 'success');
    return result;
  } catch (error) {
    const abortSource = getAbortSource?.();
    if (abortSource != null) {
      attributes['librechat.tool.abort_source'] = abortSource;
    }
    emit(
      'librechat.tool.execution.completed',
      isOwnedAbortError(error, signal) && (abortSource == null || abortSource === 'manual')
        ? 'cancelled'
        : 'error',
      error,
    );
    throw error;
  }
}
