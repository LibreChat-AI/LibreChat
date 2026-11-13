import { RunStatus } from 'librechat-data-provider';
import type { RunStep } from 'openai/resources/beta/threads/runs/steps';
import type { Run } from 'openai/resources/beta/threads/runs/runs';
import type { ChatServerFact } from 'librechat-data-provider';
import type { ProductTrackingRequest } from '~/agents/product';
import type { ProductToolIdentity } from './tools';
import { getProductBuiltinToolIdentity } from './tools';
import { trackRequestProductFact } from './request';

type Outcome = Extract<ChatServerFact, { name: 'librechat.chat.response.finished' }>['outcome'];
type Context = Pick<
  Extract<ChatServerFact, { name: 'librechat.chat.response.finished' }>,
  'conversationId' | 'agentId' | 'model' | 'provider'
>;
type ObservedRun = Pick<Run, 'id' | 'status'> &
  Partial<
    Pick<
      Run,
      | 'model'
      | 'assistant_id'
      | 'usage'
      | 'created_at'
      | 'completed_at'
      | 'failed_at'
      | 'cancelled_at'
      | 'expires_at'
      | 'required_action'
    >
  >;
type ObservedStep = Pick<RunStep, 'id' | 'run_id' | 'status' | 'step_details'> &
  Partial<
    Pick<RunStep, 'created_at' | 'completed_at' | 'failed_at' | 'cancelled_at' | 'expired_at'>
  >;

function outcome(status: string): Outcome | undefined {
  if (status === RunStatus.COMPLETED) return 'completed';
  if (status === RunStatus.CANCELLED) return 'cancelled';
  if (status === RunStatus.FAILED || status === RunStatus.EXPIRED || status === 'incomplete')
    return 'failed';
}

const count = (value: number | undefined): number | undefined =>
  Number.isSafeInteger(value) && value! >= 0 ? value : undefined;

/** One request owns the dedupe state. Provider run totals remain separate from per-call usage. */
export function createAssistantProductTracking(req: ProductTrackingRequest, context: Context) {
  const startedAt = Date.now();
  const startedRuns = new Set<string>();
  const finishedRuns = new Set<string>();
  const usageRuns = new Set<string>();
  const tools = new Map<string, { startedAt: number; finished: boolean }>();
  const emit = (fact: ChatServerFact) => trackRequestProductFact(req, fact);
  function tool(
    runId: string,
    toolCallId: string,
    productTool: ProductToolIdentity,
    result?: Outcome,
    durationMs?: number,
  ) {
    const key = `${runId}:${toolCallId}`;
    let state = tools.get(key);
    const identity = { ...context, runId, toolCallId, ...productTool, mode: 'foreground' as const };
    if (!state) {
      state = { startedAt: Date.now(), finished: false };
      tools.set(key, state);
      emit({ name: 'librechat.chat.tool.invoked', feature: 'chat', ...identity });
    }
    if (result && !state.finished) {
      state.finished = true;
      emit({
        name: 'librechat.chat.tool.finished',
        feature: 'chat',
        ...identity,
        outcome: result,
        durationMs: durationMs ?? Math.max(0, Date.now() - state.startedAt),
      });
    }
  }
  return {
    run(run: ObservedRun | null | undefined): void {
      if (!run || req.productTracking?.enabled !== true) return;
      const identity = {
        ...context,
        runId: run.id,
        model: run.model ?? context.model,
        agentId: run.assistant_id ?? context.agentId,
      };
      if (identity.agentId && !startedRuns.has(run.id)) {
        startedRuns.add(run.id);
        emit({
          name: 'librechat.chat.agent.invoked',
          feature: 'chat',
          ...identity,
          agentId: identity.agentId,
          agentInvocationId: run.id,
        });
      }
      for (const call of run.required_action?.submit_tool_outputs.tool_calls ?? []) {
        tool(run.id, call.id, { toolCategory: 'custom' });
      }
      const result = outcome(run.status);
      if (!result) return;
      if (!finishedRuns.has(run.id)) {
        finishedRuns.add(run.id);
        const end = run.completed_at ?? run.cancelled_at ?? run.failed_at;
        const durationMs =
          end != null && run.created_at != null
            ? Math.max(0, (end - run.created_at) * 1000)
            : Math.max(0, Date.now() - startedAt);
        emit({
          name: 'librechat.chat.response.finished',
          feature: 'chat',
          ...identity,
          outcome: result,
          durationMs,
        });
        if (identity.agentId)
          emit({
            name: 'librechat.chat.agent.finished',
            feature: 'chat',
            ...identity,
            agentId: identity.agentId,
            agentInvocationId: run.id,
            outcome: result,
          });
      }
      if (run.usage && !usageRuns.has(run.id)) {
        usageRuns.add(run.id);
        emit({
          name: 'librechat.chat.model.usage.recorded',
          feature: 'chat',
          ...identity,
          callId: run.id,
          usage_scope: 'run',
          outcome: result,
          input_tokens: count(run.usage.prompt_tokens),
          output_tokens: count(run.usage.completion_tokens),
          total_tokens: count(run.usage.total_tokens),
        });
      }
    },
    step(step: ObservedStep): void {
      if (req.productTracking?.enabled !== true || step.step_details.type !== 'tool_calls') return;
      for (const call of step.step_details.tool_calls) {
        const productTool =
          call.type === 'function'
            ? { toolCategory: 'custom' as const }
            : getProductBuiltinToolIdentity(call.type);
        const end = step.completed_at ?? step.cancelled_at ?? step.failed_at ?? step.expired_at;
        const durationMs =
          end != null && step.created_at != null
            ? Math.max(0, (end - step.created_at) * 1000)
            : undefined;
        tool(step.run_id, call.id, productTool, outcome(step.status), durationMs);
      }
    },
  };
}

export type AssistantProductTracking = ReturnType<typeof createAssistantProductTracking>;

/** Wiring accepts an absent host callback for integrations that do not enable product tracking. */
export function trackAssistantRun(
  tracking: AssistantProductTracking | undefined,
  run: ObservedRun | null | undefined,
): void {
  tracking?.run(run);
}

export function trackAssistantStep(
  tracking: AssistantProductTracking | undefined,
  step: ObservedStep,
): void {
  tracking?.step(step);
}
