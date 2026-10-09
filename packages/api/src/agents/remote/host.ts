import type { AgentExecutionEnrollment } from './lifecycle';
import type { AgentRunEnvelope } from '../envelope';
import { enrollAgentExecution } from './lifecycle';

/** Transport connection observed by the execution host for cancellation only. */
export interface AgentExecutionConnection {
  isClosed: () => boolean;
  onClose: (listener: () => void) => () => void;
}

export interface ExecuteAgentRunParams<Result> {
  envelope: AgentRunEnvelope;
  runId: string;
  conversationId: string;
  connection?: AgentExecutionConnection;
  isPrincipalActive: (userId: string) => Promise<boolean>;
  execute: (execution: AgentExecutionEnrollment) => Promise<Result>;
  handleExecutionError?: (error: unknown, signal?: AbortSignal) => Result | Promise<Result>;
  beforeSettle?: (
    execution: AgentExecutionEnrollment,
    executionError: unknown,
  ) => void | Promise<void>;
  onSettlementError?: (error: unknown) => void;
}

/**
 * Owns admission, cancellation, provider-start fencing, and settlement for a
 * validated Agent run. Protocol implementations own only execution semantics;
 * ingress adapters own transport validation and final rendering.
 */
export async function executeAgentRun<Result>({
  envelope,
  runId,
  conversationId,
  connection,
  isPrincipalActive,
  execute,
  handleExecutionError,
  beforeSettle,
  onSettlementError,
}: ExecuteAgentRunParams<Result>): Promise<Result> {
  const agentId = envelope.payload.model;
  let execution: AgentExecutionEnrollment | undefined;
  let executionError: unknown;
  let responseClosed = connection?.isClosed() ?? false;
  const removeCloseListener =
    connection?.onClose(() => {
      responseClosed = true;
      execution?.abort();
    }) ?? (() => undefined);

  try {
    execution = await enrollAgentExecution({
      runId,
      userId: envelope.principal.userId,
      conversationId,
      agentId,
      protocol: envelope.protocol,
      isPrincipalActive,
    });
    if (responseClosed || connection?.isClosed() === true) {
      execution.abort();
    }
    await execution.beginProviderExecution();
    return await execute(execution);
  } catch (error) {
    executionError = error;
    if (handleExecutionError != null) {
      return await handleExecutionError(error, execution?.signal);
    }
    throw error;
  } finally {
    removeCloseListener();
    if (execution != null) {
      try {
        await beforeSettle?.(execution, executionError);
      } catch (error) {
        executionError ??= error;
      }
      await execution.settle(executionError).catch((error: unknown) => {
        onSettlementError?.(error);
      });
    }
  }
}
