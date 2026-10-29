import type {
  AgentExecutionEnrollment,
  AgentExecutionEnrollmentDeps,
  ResumedAgentExecutionIdentity,
} from './lifecycle';
import type { AgentRunEnvelope } from '../envelope';
import { enrollAgentExecution, enrollResumedAgentExecution } from './lifecycle';

/** Transport connection observed by the execution host for cancellation only. */
export interface AgentExecutionConnection {
  isClosed: () => boolean;
  onClose: (listener: () => void) => () => void;
}

export interface ExecuteAgentRunParams<Result> {
  envelope: AgentRunEnvelope;
  runId: string;
  conversationId: string;
  clientRequestId?: string;
  retainTerminalPersistence?: true;
  /** Server-validated journal identity only; never copied from an API request body. */
  resume?: ResumedAgentExecutionIdentity;
  connection?: AgentExecutionConnection;
  isPrincipalActive: (userId: string) => Promise<boolean>;
  /** Persist exact execution identity before any provider/tool work may start. */
  onEnrolled?: (execution: AgentExecutionEnrollment) => void | Promise<void>;
  execute: (execution: AgentExecutionEnrollment) => Promise<Result>;
  handleExecutionError?: (error: unknown, signal?: AbortSignal) => Result | Promise<Result>;
  beforeSettle?: (
    execution: AgentExecutionEnrollment,
    executionError: unknown,
  ) => void | Promise<void>;
  onSettlementError?: (error: unknown) => void;
  /** Publish terminal output only after provider drain and trailing writes are confirmed. */
  afterSettle?: (
    execution: AgentExecutionEnrollment,
    executionError: unknown,
  ) => void | Promise<void>;
}

/**
 * Owns admission, cancellation, provider-start fencing, and settlement for a
 * validated Agent run. Protocol implementations own only execution semantics;
 * ingress adapters own transport validation and final rendering.
 */
export async function executeAgentRun<Result>(
  {
    envelope,
    runId,
    conversationId,
    clientRequestId,
    retainTerminalPersistence,
    resume,
    connection,
    isPrincipalActive,
    onEnrolled,
    execute,
    handleExecutionError,
    beforeSettle,
    onSettlementError,
    afterSettle,
  }: ExecuteAgentRunParams<Result>,
  deps?: AgentExecutionEnrollmentDeps,
): Promise<Result> {
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
    const enrollment = {
      runId,
      userId: envelope.principal.userId,
      conversationId,
      agentId,
      protocol: envelope.protocol,
      clientRequestId,
      retainTerminalPersistence,
      isPrincipalActive,
    };
    execution =
      resume == null
        ? await enrollAgentExecution(enrollment, deps)
        : await enrollResumedAgentExecution(
            { ...enrollment, ...resume, tenantId: envelope.principal.tenantId },
            deps,
          );
    if (responseClosed || connection?.isClosed() === true) {
      execution.abort();
    }
    await onEnrolled?.(execution);
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
        if (execution.ownsSettlement) await beforeSettle?.(execution, executionError);
      } catch (error) {
        executionError ??= error;
      }
      try {
        await execution.settle(executionError);
        if (execution.ownsSettlement) await afterSettle?.(execution, executionError);
      } catch (error) {
        onSettlementError?.(error);
      }
    }
  }
}
