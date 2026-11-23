import type { RunGrantIdentity } from 'librechat-data-provider';
import type { SubjectAdapter, SubjectInput } from './subject';
import { isOwnedAbortError } from '~/utils/errors';
import { RunGrantPolicyError } from './policy';

/**
 * The turn that reports work a run sent to the background: a request the trigger host makes
 * for a task's wake-up, which names no trigger and no delivery of its own. Only the signed
 * host may project a task's captured origin into completion admission.
 */
export function isCompletionTurn(req: {
  _isAgentTrigger?: boolean;
  body?: Record<string, unknown>;
}): boolean {
  return (
    req._isAgentTrigger === true &&
    typeof req.body?.conversationId === 'string' &&
    req.body.agentTrigger == null &&
    req.body.agentEventDelivery == null
  );
}

const WAKEUPS = ['subagent-completion', 'background-tool-completion'];

/**
 * The marker a completion turn carries, which names the task it reports. A marker that is not
 * one of the host's own is refused: a malformed turn is never an ordinary, unrestricted one.
 */
export function completionMarker(req: { body?: Record<string, unknown> }): object | undefined {
  const marker = req.body?.agentCompletion;
  if (marker == null) return;
  if (
    typeof marker !== 'object' ||
    !('version' in marker) ||
    marker.version !== 1 ||
    !('sourceId' in marker) ||
    !WAKEUPS.includes(String(marker.sourceId))
  )
    throw new RunGrantPolicyError('binding_mismatch', '');
  return marker;
}

/** Only authorization preparation is projected; provider failures remain caller-owned. */
async function safely(operation: () => Promise<void>, signal?: AbortSignal): Promise<void> {
  try {
    signal?.throwIfAborted();
    await operation();
    signal?.throwIfAborted();
  } catch (error) {
    if (error instanceof RunGrantPolicyError || isOwnedAbortError(error, signal)) throw error;
    throw new RunGrantPolicyError('dependency_unavailable', '');
  }
}

/**
 * Puts the request's run under one subject: who it acts for, what its delivery goes without,
 * the subject's grant where the request's tools are built, and what a later turn needs to
 * find the subject again. Refuses the run where the subject requires what it does not have.
 */
async function put<Identity extends RunGrantIdentity, Input extends SubjectInput>(
  adapter: SubjectAdapter<Identity, Input>,
  input: Input,
): Promise<void> {
  input.signal?.throwIfAborted();
  const found = await adapter.resolve(input);
  if (!found) return;
  const without = await adapter.restore?.(input, found);
  const placed = await adapter.execution.attach(
    found.context,
    found.identity,
    found.stage,
    found.require === 'grant',
    { ...found.options, ...(without && { without }) },
  );
  if (!placed && found.require === 'run')
    throw new RunGrantPolicyError('binding_mismatch', '', found.agentId);
  if (placed && adapter.retain) {
    input.signal?.throwIfAborted();
    await adapter.retain(found.identity, input);
  }
  input.signal?.throwIfAborted();
}

/** The same, for each subject that claimed the request, in the order they were given. */
async function place<Input extends SubjectInput>(
  adapters: readonly SubjectAdapter<RunGrantIdentity, Input>[],
  input: Input,
): Promise<void> {
  if (isCompletionTurn(input.req))
    await safely(async () => {
      if (!input.context) throw new RunGrantPolicyError('binding_mismatch', '');
      completionMarker(input.req);
    }, input.signal);
  for (const adapter of adapters) {
    if (adapter.opaque) await safely(() => put(adapter, input), input.signal);
    else await put(adapter, input);
  }
}

/**
 * Puts a request's run under each subject that claims it, before any of its tools is loaded.
 * A request no subject claims is left as it is.
 */
export function placeRun<Input extends SubjectInput>(
  adapters: readonly SubjectAdapter<RunGrantIdentity, Input>[],
  input: Input,
): Promise<void> {
  return place(
    adapters.filter((adapter) => adapter.claims(input)),
    input,
  );
}

/**
 * Initializes a run on the chat route under what its subject was granted, before any tool is
 * loaded. Each adapter is asked whether the request is its subject's: a schedule's occurrence
 * and the turns its tasks report back in, a delivery an API key posted, and the turns and
 * resumes that belong to either. The run is put under every subject that claims it. Any other
 * request initializes as it is, with nothing built or read for it.
 *
 * The remote API's own controllers put their runs under the key themselves and do not come
 * through here, so a run is never put under its key's grant twice.
 */
export function initializeWithAuthority<T, Input extends SubjectInput>(
  input: Input,
  adapters: readonly SubjectAdapter<RunGrantIdentity, Input>[],
  initialize: () => Promise<T>,
): Promise<T> {
  const claimed = adapters.filter((adapter) => adapter.claims(input));
  // Ordinary startup keeps its original synchronous admission of independent reads.
  if (claimed.length === 0 && !isCompletionTurn(input.req)) return initialize();
  return place(claimed, input).then(initialize);
}
