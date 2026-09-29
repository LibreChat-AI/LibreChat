import {
  ContentTypes,
  EModelEndpoint,
  PermissionBits,
  ResourceType,
} from 'librechat-data-provider';
import type { CommittedAgentHandoff } from 'librechat-data-provider';
import type { ConversationMethods } from '@librechat/data-schemas';
import type { HandoffOutcome } from '@librechat/agents';

type RoutingIdentity = Parameters<ConversationMethods['commitConvoAgentHandoff']>[0];
type CommitResult = Awaited<ReturnType<ConversationMethods['commitConvoAgentHandoff']>>;

export interface AgentHandoffAdmission {
  agentId: string;
  revision: number;
  generation: number;
  maxHandoffs: number;
}

export interface AgentHandoffRunSnapshot {
  version: 1;
  maxHandoffs: number;
  expectedRevision?: number;
  admission?: AgentHandoffAdmission;
}

export function resolveInitialHandoffRunSnapshot(input: {
  enabled: boolean;
  maxHandoffs: number;
  expectedRevision?: number;
  endpoint?: string;
  persistedAgent: boolean;
  isAutomated?: boolean;
  isTemporary?: boolean;
  isRegenerate?: boolean;
  isContinued?: boolean;
  isEdited?: boolean;
  isCompaction?: boolean;
  hasAddedConversation?: boolean;
  modelSpecEnforced?: boolean;
}): AgentHandoffRunSnapshot | undefined {
  if (
    !input.enabled ||
    input.endpoint !== EModelEndpoint.agents ||
    !input.persistedAgent ||
    input.isAutomated ||
    input.isTemporary ||
    input.isRegenerate ||
    input.isContinued ||
    input.isEdited ||
    input.isCompaction ||
    input.hasAddedConversation ||
    input.modelSpecEnforced
  ) {
    return undefined;
  }
  const snapshot = {
    version: 1 as const,
    maxHandoffs: input.maxHandoffs,
    ...(input.expectedRevision == null ? {} : { expectedRevision: input.expectedRevision }),
  };
  if (!isAgentHandoffRunSnapshot(snapshot)) {
    throw new Error('Invalid conversation handoff budget');
  }
  return snapshot;
}

export function isAgentHandoffRunSnapshot(value: unknown): value is AgentHandoffRunSnapshot {
  if (value == null || typeof value !== 'object') {
    return false;
  }
  const snapshot = value as AgentHandoffRunSnapshot;
  if (
    snapshot.version !== 1 ||
    !Number.isSafeInteger(snapshot.maxHandoffs) ||
    snapshot.maxHandoffs < 1 ||
    snapshot.maxHandoffs > 100 ||
    (snapshot.expectedRevision != null &&
      (!Number.isSafeInteger(snapshot.expectedRevision) || snapshot.expectedRevision < 0))
  ) {
    return false;
  }
  const admission = snapshot.admission;
  return (
    admission == null ||
    (typeof admission.agentId === 'string' &&
      admission.agentId.length > 0 &&
      Number.isSafeInteger(admission.revision) &&
      admission.revision >= 1 &&
      Number.isSafeInteger(admission.generation) &&
      admission.generation >= 0 &&
      admission.maxHandoffs === snapshot.maxHandoffs)
  );
}

export async function admitAgentHandoffRun(
  {
    identity,
    agentId,
    generation,
    snapshot,
  }: {
    identity: Pick<RoutingIdentity, 'user' | 'conversationId' | 'tenantId'>;
    agentId: string;
    generation: number;
    snapshot: AgentHandoffRunSnapshot;
  },
  deps: {
    admit: ConversationMethods['admitConvoAgentRoutingGeneration'];
    read: ConversationMethods['getConvoAgentRoutingDecision'];
    record: (snapshot: AgentHandoffRunSnapshot) => Promise<boolean>;
  },
): Promise<AgentHandoffRunSnapshot> {
  if (!isAgentHandoffRunSnapshot(snapshot) || snapshot.admission != null) {
    throw new Error('Invalid handoff run admission');
  }
  let admitted: Awaited<ReturnType<typeof deps.admit>>;
  try {
    admitted = await deps.admit({
      ...identity,
      expectedAgentId: agentId,
      expectedRevision: snapshot.expectedRevision ?? 0,
      generation,
    });
  } catch {
    admitted = null;
  }
  if (admitted == null) {
    try {
      const current = await deps.read(identity);
      admitted =
        current?.agentId === agentId &&
        current.generation === generation &&
        current.revision === (snapshot.expectedRevision ?? 0) + 1
          ? current
          : null;
    } catch (error) {
      throw Object.assign(new Error('Agent routing admission could not be verified'), {
        cause: error,
      });
    }
  }
  if (
    admitted?.agentId !== agentId ||
    admitted.generation !== generation ||
    !Number.isSafeInteger(admitted.revision) ||
    admitted.revision < 1
  ) {
    return snapshot;
  }
  const result = {
    ...snapshot,
    admission: {
      agentId,
      generation,
      revision: admitted.revision,
      maxHandoffs: snapshot.maxHandoffs,
    },
  };
  try {
    return (await deps.record(result)) ? result : snapshot;
  } catch (error) {
    throw Object.assign(new Error('Agent routing admission could not be recorded'), {
      cause: error,
    });
  }
}

export async function recordAgentHandoffSnapshot(
  snapshot: AgentHandoffRunSnapshot,
  generation: number,
  deps: {
    write: (snapshot: AgentHandoffRunSnapshot) => Promise<void>;
    read: () => Promise<{
      createdAt: number;
      metadata?: { agentHandoffRun?: AgentHandoffRunSnapshot };
    } | null>;
  },
): Promise<boolean> {
  if (!isAgentHandoffRunSnapshot(snapshot) || snapshot.admission?.generation !== generation) {
    return false;
  }
  await deps.write(snapshot);
  const job = await deps.read();
  const persisted = job?.metadata?.agentHandoffRun;
  return (
    job?.createdAt === generation &&
    isAgentHandoffRunSnapshot(persisted) &&
    persisted.admission?.agentId === snapshot.admission.agentId &&
    persisted.admission.revision === snapshot.admission.revision &&
    persisted.admission.generation === generation
  );
}

export function beginAgentHandoffAdmission(
  {
    snapshot,
    write,
    deferred,
    identity,
    agentId,
    expectedAgentId,
    selectedAgentId,
    generation,
  }: {
    snapshot: AgentHandoffRunSnapshot | undefined;
    write: PromiseLike<unknown> | undefined;
    deferred: boolean;
    identity: Pick<RoutingIdentity, 'user' | 'conversationId' | 'tenantId'>;
    agentId?: string;
    expectedAgentId?: string;
    selectedAgentId?: string;
    generation: number;
  },
  deps: Parameters<typeof admitAgentHandoffRun>[1],
): Promise<AgentHandoffRunSnapshot> | undefined {
  if (snapshot == null || write == null || deferred) {
    return undefined;
  }
  const ready = Promise.resolve(write).then(async (value) => {
    const saved = value as {
      message?: { _id?: unknown } | null;
      conversation?: { conversationId?: string } | null;
    } | null;
    if (
      saved?.message?._id == null ||
      saved.conversation?.conversationId !== identity.conversationId
    ) {
      return snapshot;
    }
    if (
      !agentId ||
      agentId !== expectedAgentId ||
      (selectedAgentId != null && agentId !== selectedAgentId)
    ) {
      throw new Error('Agent routing changed during initialization');
    }
    return admitAgentHandoffRun({ identity, agentId, generation, snapshot }, deps);
  });
  void ready.catch(() => {});
  return ready;
}

export interface HandoffOutcomeSource {
  getHandoffOutcome(): HandoffOutcome | undefined;
  getHaltReason?(): string | undefined;
}

export interface CommitAgentHandoffInput {
  identity: Pick<RoutingIdentity, 'user' | 'conversationId' | 'tenantId'>;
  admission: AgentHandoffAdmission | null;
  run: HandoffOutcomeSource | undefined;
  enabled: boolean;
  completed: boolean;
  responseContent?: ReadonlyArray<{ type?: string }>;
}

export function createAgentHandoffAuthorization(deps: {
  userId: string;
  role?: string | null;
  getAgent: (query: { id: string }) => Promise<{ id: string; _id: { toString(): string } } | null>;
  checkPermission: (input: {
    userId: string;
    role?: string | null;
    resourceType: ResourceType;
    resourceId: string;
    requiredPermission: number;
  }) => Promise<boolean>;
}): (agentId: string) => Promise<boolean> {
  return async (agentId) => {
    const agent = await deps.getAgent({ id: agentId });
    if (agent == null || agent.id !== agentId || agent._id == null) {
      return false;
    }
    return deps.checkPermission({
      userId: deps.userId,
      role: deps.role,
      resourceType: ResourceType.AGENT,
      resourceId: agent._id.toString(),
      requiredPermission: PermissionBits.VIEW,
    });
  };
}

export interface CommitAgentHandoffDeps {
  canAccessDestination: (agentId: string) => Promise<boolean>;
  commit: ConversationMethods['commitConvoAgentHandoff'];
  finish: ConversationMethods['finishConvoAgentRoutingGeneration'];
  read: ConversationMethods['getConvoAgentRoutingDecision'];
}

export function getCommittableAgentHandoff(
  input: CommitAgentHandoffInput,
): Extract<HandoffOutcome, { status: 'candidate' }> | null {
  const { admission, run } = input;
  if (
    !input.enabled ||
    !input.completed ||
    admission == null ||
    run == null ||
    input.responseContent?.some((part) => part.type === ContentTypes.ERROR)
  ) {
    return null;
  }
  if (run.getHaltReason?.() != null) {
    return null;
  }
  const outcome = run.getHandoffOutcome();
  if (
    outcome?.status !== 'candidate' ||
    outcome.entryAgentId !== admission.agentId ||
    !outcome.agentId ||
    outcome.agentId === admission.agentId
  ) {
    return null;
  }
  const transition = outcome.transitions.find((item) => item.id === outcome.transitionId);
  if (
    transition == null ||
    transition.scope !== 'conversation' ||
    transition.targetAgentId !== outcome.agentId
  ) {
    return null;
  }
  return outcome;
}

async function releaseUncommittedHandoff(
  input: CommitAgentHandoffInput & {
    conversation: {
      agent_id?: string;
      agentRoutingRevision?: number;
      automaticHandoffsEnabled?: boolean;
    };
  },
  deps: CommitAgentHandoffDeps,
): Promise<void> {
  if (input.admission == null) {
    return;
  }
  try {
    const decision = await deps.finish({
      ...input.identity,
      expectedAgentId: input.admission.agentId,
      expectedRevision: input.admission.revision,
      generation: input.admission.generation,
    });
    if (decision != null && decision.revision >= (input.conversation.agentRoutingRevision ?? 0)) {
      input.conversation.agent_id = decision.agentId ?? undefined;
      input.conversation.agentRoutingRevision = decision.revision;
      input.conversation.automaticHandoffsEnabled = decision.automaticHandoffsEnabled;
    }
  } catch {
    /** A failed cleanup may not hide an otherwise durable assistant response. */
  }
}

/** Mutates the outgoing conversation only after Mongo confirms the exact route decision. */
export async function reconcileTerminalAgentHandoff(
  input: CommitAgentHandoffInput & {
    conversation: {
      agent_id?: string;
      agentRoutingRevision?: number;
      automaticHandoffsEnabled?: boolean;
    };
  },
  deps: CommitAgentHandoffDeps,
): Promise<CommittedAgentHandoff | null> {
  const outcome = getCommittableAgentHandoff(input);
  if (outcome == null) {
    await releaseUncommittedHandoff(input, deps);
    return null;
  }
  const result = await commitAgentHandoff(input, deps);
  if (result == null || result.decision == null) {
    await releaseUncommittedHandoff(input, deps);
    return null;
  }
  const decision = result.decision;
  if (decision.agentId != null) {
    input.conversation.agent_id = decision.agentId;
  }
  input.conversation.agentRoutingRevision = decision.revision;
  input.conversation.automaticHandoffsEnabled = decision.automaticHandoffsEnabled;
  if (
    (result.status !== 'committed' && result.status !== 'already_committed') ||
    decision.agentId !== outcome.agentId ||
    decision.transitionId !== outcome.transitionId ||
    input.admission == null
  ) {
    await releaseUncommittedHandoff(input, deps);
    return null;
  }
  return {
    fromAgentId: input.admission.agentId,
    toAgentId: outcome.agentId,
    transitionId: outcome.transitionId,
    revision: decision.revision,
  };
}

export async function commitAgentHandoff(
  input: CommitAgentHandoffInput,
  deps: CommitAgentHandoffDeps,
): Promise<CommitResult | null> {
  const outcome = getCommittableAgentHandoff(input);
  if (outcome == null || input.admission == null) {
    return null;
  }
  try {
    if (!(await deps.canAccessDestination(outcome.agentId))) {
      return null;
    }
  } catch {
    return null;
  }
  const options = {
    ...input.identity,
    expected: {
      agentId: input.admission.agentId,
      revision: input.admission.revision,
      generation: input.admission.generation,
    },
    agentId: outcome.agentId,
    transitionId: outcome.transitionId,
  };
  try {
    return await deps.commit(options);
  } catch {
    try {
      const decision = await deps.read(input.identity);
      if (decision?.transitionId === outcome.transitionId && decision.agentId === outcome.agentId) {
        return { status: 'already_committed', decision };
      }
      return decision == null ? null : { status: 'conflict', decision };
    } catch {
      return null;
    }
  }
}
