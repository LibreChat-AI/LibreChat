import type { InitialModelBoundAdmissionCallback } from '../../middleware/modelBoundContent';
import type { getPrivateTextAdmission } from './submission';
import { getPrivateTextAdmission as getAdmission, rejectPrivateTextAdmission } from './submission';
import { ContentFilterError } from '../../middleware/contentFilter';

type ModelContext = {
  runId?: string;
  parentRunId?: string;
  metadata?: Record<string, unknown>;
};
export interface ProtectedInitialAdmission extends InitialModelBoundAdmissionCallback {
  readonly requiredConcurrency: number;
  readonly admitModel: (context: ModelContext) => Promise<void> | void;
  readonly reject: (error?: unknown) => void;
}
function blocked(): ContentFilterError {
  return new ContentFilterError({
    detectorId: 'pii-pattern',
    ruleId: 'private-text',
    label: 'private value that could not be protected',
    source: 'message',
    field: 'text',
    provenance: 'user',
    fragmentId: 'chat.text',
    fragmentPath: '/text',
  });
}

/** Every starting root must pass its exact native input before any root can invoke its model. */
export function createPrivateTextInitialAdmissionCallback(
  req: object | undefined,
  options: {
    agentIds: readonly string[];
    start: Parameters<typeof getPrivateTextAdmission>[1];
    cancel?: () => unknown;
    onPersisted?: () => void;
    signal?: AbortSignal;
  },
): ProtectedInitialAdmission | undefined {
  const commit = getAdmission(req, options.start, options.onPersisted);
  if (commit == null) {
    return;
  }
  const pending = new Set(options.agentIds);
  const parents = new Map<string, string>();
  const rootNodes = new Map<string, string>();
  let settle!: () => void;
  let fail!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  // A chain can fail before any model handler waits on the barrier.
  void ready.catch(() => {});
  let state: 'pending' | 'committing' | 'admitted' | 'rejected' = 'pending';
  const detach = () => {
    options.signal?.removeEventListener('abort', abort);
    parents.clear();
    rootNodes.clear();
  };
  const reject = (error: unknown = blocked()) => {
    if (state === 'admitted' || state === 'rejected') {
      return;
    }
    state = 'rejected';
    rejectPrivateTextAdmission(req);
    options.cancel?.();
    detach();
    fail(error);
  };
  const abort = () => reject();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted || pending.size === 0) {
    reject();
  }
  const findRoot = (parentRunId: string | undefined): string | undefined => {
    const seen = new Set<string>();
    let id = parentRunId;
    while (id != null && !seen.has(id)) {
      seen.add(id);
      const agent = rootNodes.get(id);
      if (agent != null) {
        return agent;
      }
      id = parents.get(id);
    }
    return;
  };
  const admitModel = ({ parentRunId, metadata }: ModelContext) => {
    if (state === 'admitted') {
      return;
    }
    // Summary detours need a later graph superstep. Waiting would deadlock roots
    // already at their native boundary; invoking would bypass turn admission.
    if (metadata?.summarization === true) {
      reject();
      return ready;
    }
    const agentId = findRoot(parentRunId);
    if (
      !agentId ||
      metadata?.agentId !== agentId ||
      metadata.langgraph_node !== `agent=${agentId}`
    ) {
      reject();
      return ready;
    }
    pending.delete(agentId);
    if (pending.size === 0 && state === 'pending') {
      state = 'committing';
      void commit().then(() => {
        if (state !== 'rejected') {
          state = 'admitted';
          detach();
          settle();
        }
      }, reject);
    }
    return ready;
  };
  return Object.freeze({
    name: 'librechat-initial-model-bound-admission',
    raiseError: true,
    awaitHandlers: true,
    requiredConcurrency: pending.size,
    admitModel,
    reject,
    handleChainStart: (_chain, _inputs, runId, parentRunId, _tags, metadata, _runType, runName) => {
      if (state !== 'pending') {
        return;
      }
      if (parentRunId != null) {
        parents.set(runId, parentRunId);
      }
      for (const agentId of pending) {
        if (runName === `agent=${agentId}` && metadata?.langgraph_node === runName) {
          rootNodes.set(runId, agentId);
          break;
        }
      }
    },
    handleChatModelStart: () => {},
    handleLLMEnd: () => {},
    handleLLMError: (error) => reject(error),
    handleChainEnd: (_output, runId) => {
      const agentId = rootNodes.get(runId);
      if (agentId != null && pending.has(agentId)) {
        reject();
      }
      rootNodes.delete(runId);
      parents.delete(runId);
    },
    handleChainError: (error) => reject(error),
  } satisfies ProtectedInitialAdmission);
}

/** Ordinary resumed runs retain their legacy hook; captured runs use the coordinated barrier. */
export function getPrivateTextModelHooks(
  req: object | undefined,
  initial: InitialModelBoundAdmissionCallback | ProtectedInitialAdmission | undefined,
  start: Parameters<typeof getPrivateTextAdmission>[1],
  cancel?: () => unknown,
  onPersisted?: () => void,
): {
  onContentAllowed?: (context: ModelContext) => void | Promise<void>;
  onContentRejected?: (error: unknown) => void;
} {
  if (initial != null && 'admitModel' in initial) {
    return { onContentAllowed: initial.admitModel, onContentRejected: initial.reject };
  }
  return { onContentAllowed: getAdmission(req, start, onPersisted), onContentRejected: cancel };
}

export function withPrivateTextAdmissionConfig<T extends object>(
  config: T & { maxConcurrency?: number },
  initial?: InitialModelBoundAdmissionCallback | ProtectedInitialAdmission,
): T & { callbacks?: InitialModelBoundAdmissionCallback[]; maxConcurrency?: number } {
  return initial == null
    ? config
    : {
        ...config,
        callbacks: [initial],
        ...('requiredConcurrency' in initial &&
          config.maxConcurrency != null && {
            maxConcurrency: Math.max(config.maxConcurrency, initial.requiredConcurrency),
          }),
      };
}
