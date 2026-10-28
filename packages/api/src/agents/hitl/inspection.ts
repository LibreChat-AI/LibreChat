import {
  Constants,
  resolveSubagents,
  HITL_MESSAGE_FILTER_FIELDS,
  MAX_SUBAGENT_GRAPH_NODES,
  STORED_MESSAGE_FILTER_FIELDS,
  hasActivePiiFields,
  hasActivePiiPatterns,
} from 'librechat-data-provider';
import type { Agent, FiltersConfig, UserSubmittedMessageFieldPath } from 'librechat-data-provider';
import type { AppConfig, IUser } from '@librechat/data-schemas';
import type { StoredMessageContentInput } from '~/protection/adapters/submissions';
import type { LocatorTraversalReporter } from '../../protection/diagnostics';
import type { ExternalChatMessage } from '~/protection/adapters/messages';
import {
  hasActiveFilePolicy,
  resolveCanonicalFileReferenceUnits,
  type GetCanonicalFilesForInspection,
  type CanonicalFileInspectionFile,
} from '~/protection/files';
import { ContentTraversalLimitError } from '~/protection/adapters/nested';
import { createEdgeCollector, resolveReachableGraph } from '../edges';
import { createConcurrencyLimiter } from '~/utils/promise';
import { collectReachableAgents } from '../traversal';

type ResumeMessage = StoredMessageContentInput & {
  id?: string;
  messageId?: string;
  conversationId?: string | null;
  parentMessageId?: string | null;
  isCreatedByUser?: boolean;
  isUserSubmitted?: boolean;
  userSubmittedPaths?: string[];
  userSubmittedMessageFieldPaths?: UserSubmittedMessageFieldPath[];
};

type ResumeSubmittedMessage = ExternalChatMessage & {
  readonly id?: string;
  readonly messageId?: string;
  readonly files?: readonly object[];
  readonly attachments?: readonly object[];
  readonly file_ids?: readonly string[];
};

type ResumeFile = CanonicalFileInspectionFile;

interface DynamicToolContextAgent {
  readonly dynamicToolContextMap?: Readonly<Record<string, unknown>>;
}

const RESUME_STORED_MESSAGE_FILTER_FIELDS = [
  ...STORED_MESSAGE_FILTER_FIELDS,
  ...HITL_MESSAGE_FILTER_FIELDS,
] as const;

export interface ResumeSnapshotAgent extends Agent {
  subagentAgentConfigs?: ResumeSnapshotAgent[];
}

interface ResumeAgentSnapshotInput {
  primaryAgent: Agent;
  additionalRoots?: readonly Agent[];
  primaryModelParameters?: Readonly<Record<string, unknown>>;
  capabilities: readonly string[];
  getAgent: (filter: { id: string }) => Promise<Agent | null>;
  canAccessAgent?: (agent: Agent) => Promise<boolean>;
}

type GetResumeMessages = (filter: {
  conversationId: string;
  user?: string;
}) => Promise<ResumeMessage[] | null | undefined>;

export interface ResumeContentInspectionInput {
  readonly onTraversalFailure?: LocatorTraversalReporter;
  appConfig?: AppConfig;
  conversationId: string;
  targetMessageId?: string | null;
  user?: Pick<IUser, 'id' | 'tenantId'>;
  supplementalMessages: ResumeMessage[];
  submittedMessages: ResumeSubmittedMessage[];
  /** Additional checkpoint/runtime structures that may contain durable file references. */
  fileReferenceInputs?: readonly object[];
  liveFiles: ResumeFile[];
  /** True only for files assembled from server-side attachment hydration.
   * Request/job metadata must leave this false. */
  trustLiveFileContent?: boolean;
  isTemporary: boolean;
  getMessages: GetResumeMessages;
  getFiles: GetCanonicalFilesForInspection;
}

export interface ResumeContentInspection {
  storedMessages: ResumeMessage[];
  submittedMessages: ResumeSubmittedMessage[];
  originalStoredMessages: ResumeMessage[];
  hydratedFiles: ResumeFile[];
  hydratedFilters?: FiltersConfig;
}

export function getDynamicToolContexts(agents: readonly DynamicToolContextAgent[]): string[] {
  const contexts: string[] = [];
  for (const agent of agents) {
    const context = Object.values(agent.dynamicToolContextMap ?? {})
      .filter((value): value is string => typeof value === 'string' && value !== '')
      .join('\n')
      .trim();
    if (context) {
      contexts.push(context);
    }
  }
  return contexts;
}

function getReferencedAgentIds(
  agent: Agent,
  capabilities: readonly string[],
): Array<{ id: string; terminal: boolean; required: boolean }> {
  const references = new Map<string, { id: string; terminal: boolean; required: boolean }>();
  const add = (id: string, terminal = false, required = false) => {
    if (!id || id === agent.id) return;
    const existing = references.get(id);
    references.set(id, {
      id,
      terminal: terminal && existing?.terminal !== false,
      required: required || existing?.required === true,
    });
  };
  const subagents = resolveSubagents(agent.subagents, capabilities);
  for (const id of subagents?.agent_ids ?? []) add(id);
  for (const graph of subagents?.graphs ?? []) {
    for (const id of graph.agent_ids) add(id, true, true);
  }
  return [...references.values()];
}

/**
 * Reconstructs the current saved agent graph with owner-scoped reads only.
 * It intentionally stops before initialization, so tool/provider setup and
 * resource usage mutations remain behind the approval claim.
 */
export async function getResumeAgentSnapshot({
  primaryAgent,
  additionalRoots = [],
  primaryModelParameters,
  capabilities,
  getAgent,
  canAccessAgent,
}: ResumeAgentSnapshotInput): Promise<ResumeSnapshotAgent[]> {
  const primary: ResumeSnapshotAgent = {
    ...primaryAgent,
    model_parameters: {
      ...(primaryAgent.model_parameters ?? {}),
      ...(primaryModelParameters ?? {}),
    },
    subagentAgentConfigs: [],
  };
  let roots: ResumeSnapshotAgent[] = [primary];
  const byId = new Map<string, ResumeSnapshotAgent>([[primary.id, primary]]);

  for (const root of additionalRoots) {
    if (!root?.id || byId.has(root.id)) {
      continue;
    }
    const snapshot: ResumeSnapshotAgent = { ...root, subagentAgentConfigs: [] };
    byId.set(snapshot.id, snapshot);
    roots.push(snapshot);
  }

  const unavailable = new Set<string>();
  const loadAgent = createConcurrencyLimiter(4);
  const read = async (id: string): Promise<ResumeSnapshotAgent | null> => {
    const existing = byId.get(id);
    if (existing) return existing;
    if (unavailable.has(id)) return null;
    return loadAgent(async () => {
      let loaded: Agent | null;
      try {
        loaded = await getAgent({ id });
        if (loaded && canAccessAgent && !(await canAccessAgent(loaded))) loaded = null;
      } catch {
        throw new ContentTraversalLimitError();
      }
      if (!loaded) {
        unavailable.add(id);
        return null;
      }
      const snapshot: ResumeSnapshotAgent = { ...loaded, subagentAgentConfigs: [] };
      byId.set(id, snapshot);
      return snapshot;
    });
  };

  const rootSeeds = new Set([...byId.keys(), ...(primary.agent_ids ?? [])]);
  const { agentsToProcess, collectEdges, edgeMap } = createEdgeCollector(
    (id) => byId.has(id),
    unavailable,
  );
  for (const root of roots) collectEdges(root.edges);
  /** Handoff roots and isolated members have separate bounded owner-scoped read budgets. */
  let rootReads = 0;
  while (agentsToProcess.size > 0) {
    const batch = [...agentsToProcess];
    agentsToProcess.clear();
    if (rootReads + batch.length > MAX_SUBAGENT_GRAPH_NODES) throw new ContentTraversalLimitError();
    rootReads += batch.length;
    const loaded = await Promise.all(batch.map(read));
    for (const root of loaded) {
      if (!root) continue;
      roots.push(root);
      collectEdges(root.edges);
    }
  }
  const legacyIds = [...new Set(primary.agent_ids ?? [])].filter(
    (id) => id && !byId.has(id) && !unavailable.has(id),
  );
  if (rootReads + legacyIds.length > MAX_SUBAGENT_GRAPH_NODES)
    throw new ContentTraversalLimitError();
  for (const root of await Promise.all(legacyIds.map(read))) {
    if (root) roots.push(root);
  }
  const { reachable } = resolveReachableGraph(
    rootSeeds,
    byId.keys(),
    [...edgeMap.values()],
    unavailable,
  );
  roots = roots.filter((root) => reachable.has(root.id));
  const rootIds = new Set(roots.map((root) => root.id));

  const pending = [...roots];
  const expanded = new Set<string>();
  const members = new Set<string>();
  for (let index = 0; index < pending.length; index++) {
    const agent = pending[index];
    if (expanded.has(agent.id)) continue;
    expanded.add(agent.id);
    const references = getReferencedAgentIds(agent, capabilities);
    // Saved configurations already cap unique targets, independently of successful admissions.
    if (references.length > MAX_SUBAGENT_GRAPH_NODES) throw new ContentTraversalLimitError();
    const children = await Promise.all(references.map(({ id }) => read(id)));
    const connected: ResumeSnapshotAgent[] = [];
    for (let childIndex = 0; childIndex < references.length; childIndex++) {
      const { id, terminal, required } = references[childIndex];
      const child = children[childIndex];
      if (!child) {
        if (required) throw new ContentTraversalLimitError();
        continue;
      }
      const countsAsMember = !rootIds.has(id) || (!terminal && id !== primary.id);
      if (countsAsMember && !members.has(id)) {
        if (members.size >= MAX_SUBAGENT_GRAPH_NODES) throw new ContentTraversalLimitError();
        members.add(id);
      }
      if (!terminal && !expanded.has(id)) pending.push(child);
      connected.push(child);
    }
    agent.subagentAgentConfigs = connected;
  }

  return collectReachableAgents(roots);
}

function hasResumeHistoryPolicy(appConfig: AppConfig | undefined): boolean {
  return (
    hasActivePiiPatterns(appConfig?.messageFilter?.pii) ||
    hasActivePiiFields(appConfig?.filters?.messages?.pii, RESUME_STORED_MESSAGE_FILTER_FIELDS) ||
    hasActivePiiPatterns(appConfig?.filters?.toolArguments?.pii) ||
    hasActiveFilePolicy(appConfig?.filters)
  );
}

function getMessageId(message: ResumeMessage | null | undefined): string | undefined {
  return message?.messageId ?? message?.id;
}

function getMessagesForBranch(
  messages: ResumeMessage[],
  targetMessageId: string | null | undefined,
): { branch: ResumeMessage[]; complete: boolean } {
  if (!targetMessageId) {
    return { branch: [], complete: false };
  }
  const byId = new Map<string, ResumeMessage>();
  for (const message of messages) {
    const messageId = getMessageId(message);
    if (messageId) {
      byId.set(messageId, message);
    }
  }

  const branch: ResumeMessage[] = [];
  const visited = new Set<string>();
  let currentId: string | null | undefined = targetMessageId;
  let complete = false;
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const message = byId.get(currentId);
    if (!message) {
      break;
    }
    branch.push(message);
    if (message.parentMessageId == null || message.parentMessageId === Constants.NO_PARENT) {
      complete = true;
      break;
    }
    currentId = message.parentMessageId;
  }
  branch.reverse();
  return { branch, complete };
}

async function getResumeStoredBranch({
  appConfig,
  conversationId,
  targetMessageId,
  user,
  supplementalMessages,
  isTemporary,
  getMessages,
}: Pick<
  ResumeContentInspectionInput,
  | 'appConfig'
  | 'conversationId'
  | 'targetMessageId'
  | 'user'
  | 'supplementalMessages'
  | 'isTemporary'
  | 'getMessages'
>): Promise<ResumeMessage[]> {
  if (!hasResumeHistoryPolicy(appConfig)) {
    return supplementalMessages;
  }
  if (!user?.id) {
    if (isTemporary) {
      return supplementalMessages;
    }
    throw new ContentTraversalLimitError();
  }

  let persistedMessages: ResumeMessage[];
  try {
    persistedMessages =
      (await getMessages({
        conversationId,
        user: user?.id,
      })) ?? [];
  } catch {
    throw new ContentTraversalLimitError();
  }

  const supplementalById = new Map<string, ResumeMessage>();
  for (const message of supplementalMessages) {
    const messageId = getMessageId(message);
    if (messageId) {
      supplementalById.set(messageId, message);
    }
  }

  const persistedTarget = persistedMessages.some(
    (message) => getMessageId(message) === targetMessageId,
  );
  const supplementalTarget =
    targetMessageId == null ? undefined : supplementalById.get(targetMessageId);
  let branch: ResumeMessage[];
  if (persistedTarget) {
    const recovered = getMessagesForBranch(persistedMessages, targetMessageId);
    branch = recovered.branch;
    if (
      getMessageId(branch[branch.length - 1]) !== targetMessageId ||
      (!recovered.complete && !isTemporary)
    ) {
      throw new ContentTraversalLimitError();
    }
  } else if (supplementalTarget) {
    const parentId = supplementalTarget.parentMessageId;
    const recovered =
      parentId == null || parentId === Constants.NO_PARENT
        ? { branch: [], complete: true }
        : getMessagesForBranch(persistedMessages, parentId);
    branch = recovered.branch;
    const parentFound =
      parentId == null ||
      parentId === Constants.NO_PARENT ||
      getMessageId(branch[branch.length - 1]) === parentId;
    if ((!parentFound || !recovered.complete) && !isTemporary) {
      throw new ContentTraversalLimitError();
    }
    branch.push(supplementalTarget);
  } else if (isTemporary) {
    branch = [];
  } else {
    throw new ContentTraversalLimitError();
  }

  const branchIds = new Set(branch.map(getMessageId).filter((id): id is string => Boolean(id)));
  for (const message of supplementalMessages) {
    const messageId = getMessageId(message);
    if (!messageId || branchIds.has(messageId)) {
      continue;
    }
    branch.push(message);
    branchIds.add(messageId);
  }
  return branch;
}

async function getResumeFileInspection(
  input: ResumeContentInspectionInput,
  storedMessages: ResumeMessage[],
): Promise<ResumeContentInspection> {
  const filters = input.appConfig?.filters;
  if (!hasActiveFilePolicy(filters)) {
    return {
      storedMessages,
      submittedMessages: input.submittedMessages,
      originalStoredMessages: storedMessages,
      hydratedFiles: [],
      hydratedFilters: filters,
    };
  }

  const units = [
    ...storedMessages.map((storedMessage) => ({ storedMessage })),
    ...input.submittedMessages.map((submittedMessage) => ({ submittedMessage })),
    ...(input.fileReferenceInputs ?? []).map((fileReferenceInput) => ({ fileReferenceInput })),
  ];
  const fileInspection = await resolveCanonicalFileReferenceUnits({
    messageCount: storedMessages.length + input.submittedMessages.length,
    onTraversalFailure: input.onTraversalFailure,
    filters,
    input: units,
    user: input.user,
    ...(input.trustLiveFileContent === true && {
      trustedLiveFiles: input.liveFiles,
    }),
    getFiles: input.getFiles,
  });
  return {
    storedMessages: fileInspection.sanitizedInput.flatMap((unit) =>
      'storedMessage' in unit ? [unit.storedMessage] : [],
    ),
    submittedMessages: fileInspection.sanitizedInput.flatMap((unit) =>
      'submittedMessage' in unit ? [unit.submittedMessage] : [],
    ),
    originalStoredMessages: storedMessages,
    hydratedFiles: fileInspection.hydratedFiles,
    hydratedFilters: fileInspection.hydratedFilters,
  };
}

export async function getResumeContentInspection(
  input: ResumeContentInspectionInput,
): Promise<ResumeContentInspection> {
  const storedMessages = await getResumeStoredBranch(input);
  return getResumeFileInspection(input, storedMessages);
}
