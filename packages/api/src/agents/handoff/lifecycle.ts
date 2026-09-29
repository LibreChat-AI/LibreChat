import {
  ContentTypes,
  DEFAULT_CONVERSATION_HANDOFF_BUDGET,
  isEphemeralAgentId,
} from 'librechat-data-provider';
import type { CommittedAgentHandoff } from 'librechat-data-provider';
import type {
  AgentHandoffRunSnapshot,
  CommitAgentHandoffDeps,
  HandoffOutcomeSource,
} from '../promotion';
import {
  admitAgentHandoffRun,
  beginAgentHandoffAdmission,
  createAgentHandoffAuthorization,
  reconcileTerminalAgentHandoff,
  recordAgentHandoffSnapshot,
  resolveInitialHandoffRunSnapshot,
} from '../promotion';

/** Server-owned request facts. The controller supplies data; the lifecycle owns eligibility. */
export interface AgentHandoffStartup {
  agentId?: string;
  endpoint?: string;
  config?: { enabled?: boolean; maxHandoffs?: number };
  expectedRevision?: number;
  scheduled?: boolean;
  trigger?: boolean;
  recovered?: boolean;
  temporary?: boolean;
  regenerate?: boolean;
  continued?: boolean;
  editedContent?: unknown;
  overrideParentMessageId?: unknown;
  editedResponseMessageId?: unknown;
  overrideConversationId?: unknown;
  compaction?: boolean;
  addedConversation?: unknown;
  modelSpecEnforced?: boolean;
}

export function resolveAgentHandoffStartup(
  input: AgentHandoffStartup,
): AgentHandoffRunSnapshot | undefined {
  return resolveInitialHandoffRunSnapshot({
    enabled: input.config?.enabled === true,
    maxHandoffs: input.config?.maxHandoffs ?? DEFAULT_CONVERSATION_HANDOFF_BUDGET,
    expectedRevision: input.expectedRevision,
    endpoint: input.endpoint,
    persistedAgent: typeof input.agentId === 'string' && !isEphemeralAgentId(input.agentId),
    isAutomated: input.scheduled || input.trigger || input.recovered,
    isTemporary: input.temporary,
    isRegenerate: input.regenerate,
    isContinued: input.continued,
    isEdited:
      input.editedContent != null ||
      input.overrideParentMessageId != null ||
      input.editedResponseMessageId != null ||
      input.overrideConversationId != null,
    isCompaction: input.compaction,
    hasAddedConversation: input.addedConversation != null,
    modelSpecEnforced: input.modelSpecEnforced,
  });
}

type HandoffIdentity = Parameters<typeof admitAgentHandoffRun>[0]['identity'];
type HandoffAuthorization = Parameters<typeof createAgentHandoffAuthorization>[0];
type AdmissionDeps = Parameters<typeof admitAgentHandoffRun>[1];

export interface AgentHandoffLifecycleInput {
  identity: HandoffIdentity;
  agentId?: string;
  generation: number;
  role?: string | null;
  enabled: boolean;
  snapshot?: AgentHandoffRunSnapshot;
  selectedAgentId?: string;
}

export interface AgentHandoffLifecycleDeps
  extends Pick<AdmissionDeps, 'admit' | 'read'>,
    Pick<CommitAgentHandoffDeps, 'commit' | 'finish'>,
    Pick<HandoffAuthorization, 'getAgent' | 'checkPermission'> {
  updateMetadata: (
    streamId: string,
    value: { agentHandoffRun: AgentHandoffRunSnapshot },
    generation: number,
  ) => Promise<void>;
  getJob: (streamId: string) => Promise<{
    createdAt: number;
    metadata?: { agentHandoffRun?: AgentHandoffRunSnapshot };
  } | null>;
}

export interface TerminalHandoffInput {
  ready?: Promise<AgentHandoffRunSnapshot>;
  run?: HandoffOutcomeSource;
  status: string;
  unfinished: boolean;
  responseError?: boolean;
  responseContent?: ReadonlyArray<{ type?: string }>;
  conversation: {
    agent_id?: string;
    agentRoutingRevision?: number;
    automaticHandoffsEnabled?: boolean;
  };
}

export interface AgentHandoffLifecycle {
  begin(
    write: PromiseLike<unknown> | undefined,
    deferred: boolean,
    actualAgentId?: string,
  ): Promise<AgentHandoffRunSnapshot> | undefined;
  complete(terminal: TerminalHandoffInput): Promise<CommittedAgentHandoff | null>;
}

/** One owner for fresh and reconstructed runs. Called only after the response write is durable. */
export function createAgentHandoffLifecycle(
  input: AgentHandoffLifecycleInput,
  deps: AgentHandoffLifecycleDeps,
): AgentHandoffLifecycle {
  const { identity, agentId, generation, snapshot, enabled, selectedAgentId } = input;
  const record: AdmissionDeps['record'] = (value) =>
    recordAgentHandoffSnapshot(value, generation, {
      write: (next) =>
        deps.updateMetadata(identity.conversationId, { agentHandoffRun: next }, generation),
      read: () => deps.getJob(identity.conversationId),
    });
  const admissionDeps = { admit: deps.admit, read: deps.read, record };
  const canAccessDestination = createAgentHandoffAuthorization({
    userId: identity.user,
    role: input.role,
    getAgent: deps.getAgent,
    checkPermission: deps.checkPermission,
  });
  const commitDeps = {
    canAccessDestination,
    commit: deps.commit,
    finish: deps.finish,
    read: deps.read,
  };

  return {
    begin(
      write: PromiseLike<unknown> | undefined,
      deferred: boolean,
      actualAgentId?: string,
    ): Promise<AgentHandoffRunSnapshot> | undefined {
      return beginAgentHandoffAdmission(
        {
          snapshot,
          write,
          deferred,
          identity,
          agentId: actualAgentId,
          expectedAgentId: agentId,
          selectedAgentId,
          generation,
        },
        admissionDeps,
      );
    },
    async complete(terminal: TerminalHandoffInput): Promise<CommittedAgentHandoff | null> {
      const current = (await terminal.ready) ?? snapshot;
      if (current == null) return null;
      const completed =
        terminal.status === 'complete' &&
        !terminal.unfinished &&
        terminal.responseError !== true &&
        !terminal.responseContent?.some((part) => part.type === ContentTypes.ERROR);
      const admitted =
        completed && enabled && current.admission == null && agentId != null
          ? await admitAgentHandoffRun(
              { identity, agentId, generation, snapshot: current },
              admissionDeps,
            )
          : current;
      return reconcileTerminalAgentHandoff(
        {
          identity,
          admission: admitted.admission ?? null,
          run: terminal.run,
          enabled,
          completed,
          responseContent: terminal.responseContent,
          conversation: terminal.conversation,
        },
        commitDeps,
      );
    },
  };
}
