import { createHash, randomUUID } from 'node:crypto';
import { HumanMessage } from '@librechat/agents/langchain';
import type { Agent, RunFileProvenance, TFile, TAgentsEndpoint } from 'librechat-data-provider';
import type { SubagentExecutionContext } from '@librechat/agents';
import type { BaseMessage } from '@librechat/agents/langchain';
import type {
  RunFileActor,
  RunFileManifest,
  RunFileScope,
  RunFileEntry,
  RunFileAudit,
  RunFileReadMode,
} from './manifest';
import type { RunArtifactDescriptor } from '~/files/code/publication';
import type { RunFileSnapshotStore } from './snapshots';
import type { RunFileMessageEncoder } from './encode';
import { createRunFileManifest, describeRunFiles } from './manifest';

export interface SharedRunArtifact {
  id: string;
  filename: string;
  sha256: string;
  source: RunArtifactDescriptor;
}

export function getAuthorizedRunFileSnapshot({
  policy,
  agent,
  files,
}: {
  policy?: TAgentsEndpoint['fileSharing'];
  agent: Pick<Agent, 'subagents'>;
  files: readonly TFile[];
}): readonly TFile[] | undefined {
  return policy?.enabled === true &&
    agent.subagents?.enabled === true &&
    agent.subagents.shareFiles === true
    ? files
    : undefined;
}

export interface RunFilePreparation {
  executionContext: SubagentExecutionContext;
  memberAgentIds: readonly string[];
  signal: AbortSignal;
  resumed: boolean;
}

export interface RunFileSessionDeps {
  policy?: TAgentsEndpoint['fileSharing'];
  userId: string;
  tenantId?: string;
  createdAt: number;
  audit?: (event: RunFileAudit) => void;
  getAgent: (id: string) => Pick<Agent, 'id' | 'subagents'> | undefined;
  getInputs: () => readonly TFile[];
  inputFileIds: ReadonlySet<string>;
  listPublications: (scope: RunFileScope) => Promise<TFile[]>;
  snapshots: Pick<RunFileSnapshotStore, 'capture' | 'discard' | 'close'>;
  publish: (params: {
    scope: RunFileScope;
    artifact: RunArtifactDescriptor;
    provenance: RunFileProvenance;
    signal?: AbortSignal;
  }) => Promise<TFile>;
  prepareAgent: (params: {
    actor: RunFileActor;
    files: TFile[];
    sessionKey: string;
    revision: number;
    signal: AbortSignal;
  }) => Promise<void>;
  validateMessages: RunFileMessageEncoder['validate'];
  encodeMessages: RunFileMessageEncoder['encode'];
  emit: (
    file: TFile & { messageId: string; toolCallId?: string; agentId: string },
  ) => Promise<void>;
}

export interface CapturedRunArtifact {
  session_id?: string;
  files?: Array<{
    id: string;
    name: string;
    session_id?: string;
    storage_session_id?: string;
    inherited?: boolean;
  }>;
}

export interface PreparedRunFiles {
  messages?: BaseMessage[];
  agentSessions?: Record<string, { codeSessionKey: string }>;
}

export interface RunFileSession {
  activate: (
    runId: string,
    conversationId: string,
    agentIds: string[],
    signal?: AbortSignal,
  ) => boolean;
  prepare: (input: RunFilePreparation) => Promise<PreparedRunFiles>;
  complete: (
    input: RunFilePreparation,
    result: { content: string },
  ) => Promise<{ content: string }>;
  list: (
    agentId: string,
    context?: SubagentExecutionContext,
    signal?: AbortSignal,
  ) => Promise<{
    files: RunFileEntry[];
    artifacts: Array<{ artifact_id: string; filename: string }>;
    private_artifact_recovery?: string;
  }>;
  capture: (
    agentId: string,
    context: SubagentExecutionContext | undefined,
    toolCallId: string,
    artifact: CapturedRunArtifact,
    codeExecutionContext?: RunArtifactDescriptor['codeExecutionContext'],
  ) => Promise<boolean>;
  withCodeExecution: <T>(
    agentId: string,
    context: SubagentExecutionContext | undefined,
    signal: AbortSignal,
    execute: () => Promise<T>,
  ) => Promise<T>;
  publish: (
    agentId: string,
    context: SubagentExecutionContext | undefined,
    artifactId: string,
    recipients?: string[],
    signal?: AbortSignal,
  ) => Promise<TFile>;
  prepareTools: (
    agentId: string,
    context: SubagentExecutionContext | undefined,
    signal: AbortSignal,
    mode?: RunFileReadMode,
  ) => Promise<void>;
  actorFor: (agentId: string, context?: SubagentExecutionContext) => RunFileActor;
  close: () => Promise<void>;
  isActive: () => boolean;
}

/** Coordinates the SDK's execution identities with file grants and host-owned tool contexts. */
export function createRunFileSession(deps: RunFileSessionDeps): RunFileSession {
  let manifest: RunFileManifest<SharedRunArtifact> | undefined;
  let scope: RunFileScope | undefined;
  let rootAgentId: string | undefined;
  const contexts = new Map<string, SubagentExecutionContext>();
  const members = new Map<string, readonly string[]>();
  const staged = new Map<string, Map<string, SharedRunArtifact>>();
  const lifetime = new AbortController();
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let runSignal: AbortSignal | undefined;
  let closing: Promise<void> | undefined;
  const codeOperations = new Map<string, Promise<void>>();
  const codeSignals = new Map<string, AbortSignal>();
  const preparations = new Map<string, number>();
  const resumedExecutions = new Set<string>();

  function nextPreparation(actor: RunFileActor): number {
    const key = JSON.stringify(actor);
    const next = (preparations.get(key) ?? 0) + 1;
    preparations.set(key, next);
    return next;
  }

  function allowedAgentIds(agentIds: readonly string[]): string[] {
    const allowed = new Set<string>();
    for (const id of agentIds) {
      const agent = deps.getAgent(id);
      if (!agent?.subagents?.enabled) continue;
      if (agent.subagents.allowSelf !== false) allowed.add(id);
      for (const childId of agent.subagents.agent_ids ?? []) allowed.add(childId);
      for (const graph of agent.subagents.graphs ?? []) {
        for (const member of graph.agent_ids) allowed.add(member);
      }
    }
    return [...allowed];
  }

  function activate(
    runId: string,
    conversationId: string,
    agentIds: string[],
    signal?: AbortSignal,
  ): boolean {
    const root = deps.getAgent(agentIds[0]);
    if (
      deps.policy?.enabled !== true ||
      root?.subagents?.enabled !== true ||
      root.subagents.shareFiles !== true
    )
      return false;
    if (scope != null) {
      if (scope.runId !== runId || scope.conversationId !== conversationId) {
        throw new Error('A shared-file session cannot be reused by another run.');
      }
      return true;
    }
    scope = { userId: deps.userId, tenantId: deps.tenantId, conversationId, runId };
    rootAgentId = agentIds[0];
    members.set(runId, [...agentIds]);
    manifest = createRunFileManifest({
      scope,
      policy: deps.policy,
      root: { id: runId, agentIds, allowedAgentIds: allowedAgentIds(agentIds) },
      inputFiles: deps.getInputs(),
      inputFileIds: deps.inputFileIds,
      createdAt: deps.createdAt,
      audit: deps.audit,
      store: {
        list: deps.listPublications,
        publish: ({ scope: publicationScope, artifact, provenance, signal }) =>
          deps.publish({ scope: publicationScope, artifact: artifact.source, provenance, signal }),
      },
    });
    runSignal = signal;
    signal?.addEventListener('abort', endRun, { once: true });
    expiryTimer = setTimeout(endRun, Math.max(0, deps.createdAt + deps.policy.ttlMs - Date.now()));
    expiryTimer.unref?.();
    if (signal?.aborted) endRun();
    return true;
  }

  function actorFor(agentId: string, context?: SubagentExecutionContext): RunFileActor {
    if (!scope || !manifest) throw new Error('Run file sharing is not active.');
    lifetime.signal.throwIfAborted();
    if (context == null) return { executionId: scope.runId, agentId };
    const leaf = context.ancestry[context.ancestry.length - 1];
    const registered = leaf && contexts.get(leaf.subagentRunId);
    if (!registered || lineageKey(context) !== lineageKey(registered)) {
      throw new Error('The child execution is not authorized for this shared-file run.');
    }
    return { executionId: leaf.subagentRunId, agentId };
  }

  function lineageKey(context: SubagentExecutionContext): string {
    return JSON.stringify([
      context.rootRunId,
      context.depth,
      context.ancestry.map((entry) => [
        entry.subagentRunId,
        entry.parentRunId,
        entry.parentAgentId,
        entry.parentToolCallId,
        entry.subagentType,
        entry.subagentKind,
        entry.subagentAgentId,
      ]),
    ]);
  }

  function sessionKey(actor: RunFileActor): string {
    return createHash('sha256')
      .update(JSON.stringify([scope?.tenantId, scope?.userId, scope?.runId, actor]))
      .digest('hex');
  }

  async function prepare(input: RunFilePreparation) {
    if (!manifest || !scope) return {};
    const { executionContext: context, memberAgentIds, signal } = input;
    const leaf = context.ancestry[context.ancestry.length - 1];
    if (context.rootRunId !== scope.runId || !leaf || context.depth !== context.ancestry.length) {
      throw new Error('Invalid shared-file execution lineage.');
    }
    const parentId = context.ancestry[context.ancestry.length - 2]?.subagentRunId ?? scope.runId;
    const parentContext = contexts.get(parentId);
    const expectedPrefix = parentContext?.ancestry ?? [];
    const prefix = {
      ...context,
      depth: context.depth - 1,
      ancestry: context.ancestry.slice(0, -1),
    };
    if (
      !leaf.parentAgentId ||
      !members.get(parentId)?.includes(leaf.parentAgentId) ||
      leaf.parentRunId !== parentId ||
      lineageKey(prefix) !==
        lineageKey({ ...context, depth: expectedPrefix.length, ancestry: expectedPrefix })
    ) {
      throw new Error('Invalid shared-file parent lineage.');
    }
    const registered = contexts.get(leaf.subagentRunId);
    if (registered && lineageKey(registered) !== lineageKey(context)) {
      throw new Error('A shared-file execution lineage cannot be reassigned.');
    }
    manifest.register({
      id: leaf.subagentRunId,
      parentId,
      parentAgentId: leaf.parentAgentId,
      agentIds: memberAgentIds,
      allowedAgentIds: allowedAgentIds(memberAgentIds),
    });
    contexts.set(leaf.subagentRunId, structuredClone(context));
    members.set(leaf.subagentRunId, [...memberAgentIds]);
    if (input.resumed) resumedExecutions.add(leaf.subagentRunId);
    const agentSessions: Record<string, { codeSessionKey: string }> = {};
    const preparations = await Promise.all(
      memberAgentIds.map(async (agentId) => {
        const actor = actorFor(agentId, context);
        const revision = nextPreparation(actor);
        const files = await manifest!.getFiles(actor, signal);
        const key = sessionKey(actor);
        if (!input.resumed) deps.validateMessages(files, agentId);
        return { actor, files, sessionKey: key, revision, signal };
      }),
    );
    await Promise.all(
      preparations.map(async (preparation) => {
        await deps.prepareAgent(preparation);
        const {
          actor: { agentId },
          sessionKey: key,
        } = preparation;
        agentSessions[agentId] = { codeSessionKey: key };
      }),
    );
    let messages: BaseMessage[] = [];
    if (!input.resumed && preparations.length > 0) {
      const {
        actor: { agentId },
        files,
      } = preparations[0];
      const catalog = describeRunFiles(files, scope.runId);
      messages = [
        new HumanMessage({
          content: `Files shared for this task (read-only inputs):\n${JSON.stringify(catalog)}\nUse list_run_files to discover later publications. Generated outputs remain private until publish_artifact succeeds.`,
        }),
        ...(await deps.encodeMessages(files, agentId)),
      ];
    }
    return { messages, agentSessions };
  }

  async function list(agentId: string, context?: SubagentExecutionContext, signal?: AbortSignal) {
    const actor = actorFor(agentId, context);
    const files = await manifest!.list(actor, signal);
    return {
      files,
      ...(resumedExecutions.has(actor.executionId)
        ? {
            private_artifact_recovery:
              'Previously unpublished outputs are not restored. Regenerate them with the producing tool before publishing.',
          }
        : {}),
      artifacts: [...(staged.get(JSON.stringify(actor))?.values() ?? [])].map((artifact) => ({
        artifact_id: artifact.id,
        filename: artifact.filename,
      })),
    };
  }

  async function capture(
    agentId: string,
    context: SubagentExecutionContext | undefined,
    toolCallId: string,
    artifact: CapturedRunArtifact,
    codeExecutionContext?: RunArtifactDescriptor['codeExecutionContext'],
  ): Promise<boolean> {
    if (!manifest || !context) return false;
    const actor = actorFor(agentId, context);
    const key = JSON.stringify(actor);
    const incomingFiles = (artifact.files ?? []).filter((file) => file.inherited !== true);
    const operationSignal = codeSignals.get(key);
    const captureSignal = operationSignal
      ? AbortSignal.any([lifetime.signal, operationSignal])
      : lifetime.signal;
    const outputs = staged.get(key) ?? new Map<string, SharedRunArtifact>();
    staged.set(key, outputs);
    for (const file of incomingFiles) {
      const sessionId = file.storage_session_id ?? file.session_id ?? artifact.session_id;
      if (!sessionId) throw new Error('The generated artifact has no sandbox identity.');
      const source: RunArtifactDescriptor = {
        id: file.id,
        name: file.name,
        sessionId,
        codeExecutionContext,
      };
      const snapshot = await deps.snapshots.capture(source, captureSignal);
      let retained = false;
      try {
        captureSignal.throwIfAborted();
        // Reading an unchanged file must not consume another catalog entry. A
        // content comparison is required: providers may reuse IDs after a write.
        let latest: SharedRunArtifact | undefined;
        for (const output of outputs.values()) {
          if (output.filename === file.name) latest = output;
        }
        if (latest?.sha256 === snapshot.sha256) {
          continue;
        }
        const value: SharedRunArtifact = {
          id: `${randomUUID()}:${toolCallId}:${file.id}`,
          filename: file.name,
          sha256: snapshot.sha256,
          source: { ...source, snapshotId: snapshot.snapshotId },
        };
        manifest.stage(actor, value);
        outputs.set(value.id, value);
        retained = true;
      } finally {
        if (!retained) await deps.snapshots.discard(snapshot.snapshotId);
      }
    }
    return true;
  }

  function withCodeExecution<T>(
    agentId: string,
    context: SubagentExecutionContext | undefined,
    signal: AbortSignal,
    execute: () => Promise<T>,
  ): Promise<T> {
    if (!manifest) return execute();
    const key = JSON.stringify(actorFor(agentId, context));
    const previous = codeOperations.get(key) ?? Promise.resolve();
    const operation = previous.then(async () => {
      signal.throwIfAborted();
      lifetime.signal.throwIfAborted();
      codeSignals.set(key, signal);
      try {
        return await execute();
      } finally {
        codeSignals.delete(key);
      }
    });
    const settled = operation.then(
      () => undefined,
      () => undefined,
    );
    codeOperations.set(key, settled);
    void settled.then(() => {
      if (codeOperations.get(key) === settled) codeOperations.delete(key);
    });
    return operation;
  }

  async function publish(
    agentId: string,
    context: SubagentExecutionContext | undefined,
    artifactId: string,
    recipients: string[] = [],
    signal?: AbortSignal,
  ): Promise<TFile> {
    const actor = actorFor(agentId, context);
    const key = JSON.stringify(actor);
    const snapshotId = staged.get(key)?.get(artifactId)?.source.snapshotId;
    const publicationSignal = signal ? AbortSignal.any([lifetime.signal, signal]) : lifetime.signal;
    const file = await manifest!.publish(actor, artifactId, recipients, publicationSignal);
    staged.get(key)?.delete(artifactId);
    if (snapshotId) {
      try {
        await deps.snapshots.discard(snapshotId);
      } catch {
        // The durable publication already committed. A private cleanup failure
        // must not turn it into an apparent publish failure; close retries it.
        deps.audit?.({
          action: 'cleanup_failed',
          scope: scope!,
          executionId: actor.executionId,
          agentId,
          fileIds: [],
        });
      }
    }
    publicationSignal.throwIfAborted();
    const rootDispatch = context?.ancestry[0];
    await deps.emit({
      ...file,
      messageId: scope!.runId,
      toolCallId: rootDispatch?.parentToolCallId,
      agentId: rootDispatch?.parentAgentId ?? rootAgentId!,
    });
    return file;
  }

  async function complete(input: RunFilePreparation, result: { content: string }) {
    if (!manifest) return result;
    const memberFiles = await Promise.all(
      input.memberAgentIds.map((agentId) =>
        manifest!.getFiles(actorFor(agentId, input.executionContext), input.signal),
      ),
    );
    const ancestry = input.executionContext.ancestry;
    const executionId = ancestry[ancestry.length - 1]?.subagentRunId;
    const published = [
      ...new Map(
        memberFiles
          .flat()
          .filter((file) => file.metadata?.runFile?.executionId === executionId)
          .map((file) => [file.file_id, file]),
      ).values(),
    ];
    if (published.length === 0) return result;
    return {
      content: `${result.content}\n\nPublished files: ${JSON.stringify(published.map((file) => ({ file_id: file.file_id, filename: file.filename })))}`,
    };
  }

  async function prepareTools(
    agentId: string,
    context: SubagentExecutionContext | undefined,
    signal: AbortSignal,
    mode: RunFileReadMode = 'refresh',
  ) {
    if (!manifest) return;
    const actor = actorFor(agentId, context);
    const revision = nextPreparation(actor);
    await deps.prepareAgent({
      actor,
      files: await manifest.getFiles(actor, signal, mode),
      sessionKey: sessionKey(actor),
      revision,
      signal,
    });
  }

  function endRun(): void {
    void close();
  }

  function close(): Promise<void> {
    if (closing) return closing;
    clearTimeout(expiryTimer);
    runSignal?.removeEventListener('abort', endRun);
    lifetime.abort(new Error('This shared-file run has expired. Attach the file to a new turn.'));
    codeOperations.clear();
    codeSignals.clear();
    manifest?.close();
    staged.clear();
    contexts.clear();
    members.clear();
    preparations.clear();
    resumedExecutions.clear();
    closing = deps.snapshots.close().catch(() => {
      if (scope)
        deps.audit?.({ action: 'cleanup_failed', scope, executionId: scope.runId, fileIds: [] });
    });
    return closing;
  }

  return {
    activate,
    prepare,
    complete,
    list,
    capture,
    withCodeExecution,
    publish,
    prepareTools,
    actorFor,
    close,
    isActive: () => manifest != null,
  };
}
