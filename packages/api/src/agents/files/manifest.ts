import { canToolResourceConsume, EToolResources, FileSources } from 'librechat-data-provider';
import type { RunFileProvenance, TFile } from 'librechat-data-provider';

export interface RunFileScope {
  userId: string;
  tenantId?: string;
  conversationId: string;
  runId: string;
}

export interface RunFilePolicy {
  allowSiblingSharing: boolean;
  maxFiles: number;
  ttlMs: number;
}

export interface RunFileExecution {
  id: string;
  parentId?: string;
  parentAgentId?: string;
  agentIds: readonly string[];
  allowedAgentIds: readonly string[];
}

export interface RunFileActor {
  executionId: string;
  agentId: string;
}

export interface RunArtifact {
  id: string;
  filename: string;
}

export interface RunFileEntry {
  file_id: string;
  filename: string;
  type: string;
  source?: FileSources;
  llmDeliveryPath?: TFile['llmDeliveryPath'];
  paths: Array<'provider' | 'text' | EToolResources.execute_code | EToolResources.file_search>;
  provenance: RunFileProvenance | { kind: 'user_attachment'; runId: string };
}

/** Describes an already authorized snapshot without another storage read. */
export function describeRunFiles(files: readonly TFile[], runId: string): RunFileEntry[] {
  return files.map((file) => {
    const paths: RunFileEntry['paths'] = [];
    if (file.llmDeliveryPath === 'provider') paths.push('provider');
    if (file.llmDeliveryPath === 'text' || file.source === FileSources.text) paths.push('text');
    const chosen = file.metadata?.destinationChosen !== false;
    if (file.source !== FileSources.text) {
      if (
        canToolResourceConsume(EToolResources.execute_code, file.type) &&
        (!chosen || file.metadata?.codeEnvRef != null || file.metadata?.codeEnvRefs != null)
      )
        paths.push(EToolResources.execute_code);
      if (
        canToolResourceConsume(EToolResources.file_search, file.type) &&
        (!chosen || file.embedded)
      )
        paths.push(EToolResources.file_search);
    }
    return {
      file_id: file.file_id,
      filename: file.filename,
      type: file.type,
      source: file.source,
      llmDeliveryPath: file.llmDeliveryPath,
      paths,
      provenance: file.metadata?.runFile ?? { kind: 'user_attachment', runId },
    };
  });
}

export interface RunFileStore<TArtifact extends RunArtifact> {
  list: (scope: RunFileScope) => Promise<TFile[]>;
  publish: (params: {
    scope: RunFileScope;
    artifact: TArtifact;
    provenance: RunFileProvenance;
    signal?: AbortSignal;
  }) => Promise<TFile>;
}

export interface RunFileAudit {
  action: 'inherit' | 'publish' | 'expire' | 'cleanup_failed';
  scope: RunFileScope;
  executionId: string;
  agentId?: string;
  fileIds: string[];
  recipientAgentIds?: string[];
}

export type RunFileReadMode = 'refresh' | 'snapshot';

export interface RunFileManifest<TArtifact extends RunArtifact = RunArtifact> {
  register: (execution: RunFileExecution) => void;
  getFiles: (actor: RunFileActor, signal?: AbortSignal, mode?: RunFileReadMode) => Promise<TFile[]>;
  list: (actor: RunFileActor, signal?: AbortSignal) => Promise<RunFileEntry[]>;
  stage: (actor: RunFileActor, artifact: TArtifact) => void;
  discardArtifacts: (actor: RunFileActor) => void;
  publish: (
    actor: RunFileActor,
    artifactId: string,
    recipientAgentIds?: string[],
    signal?: AbortSignal,
  ) => Promise<TFile>;
  close: () => void;
}

/** Metadata and grants are run-local; canonical file bytes remain in the unified file store. */
export function createRunFileManifest<TArtifact extends RunArtifact>({
  scope,
  policy,
  root,
  inputFiles,
  inputFileIds,
  createdAt,
  store,
  now = Date.now,
  audit = () => undefined,
}: {
  scope: RunFileScope;
  policy: RunFilePolicy;
  root: RunFileExecution;
  inputFiles: readonly TFile[];
  inputFileIds: ReadonlySet<string>;
  createdAt: number;
  store: RunFileStore<TArtifact>;
  now?: () => number;
  audit?: (event: RunFileAudit) => void;
}): RunFileManifest<TArtifact> {
  if (!scope.userId || !scope.conversationId || !scope.runId || root.parentId != null) {
    throw new Error('Invalid shared-file run identity.');
  }
  if (!Number.isFinite(createdAt) || policy.maxFiles < 1 || policy.ttlMs < 1) {
    throw new Error('Invalid shared-file run policy.');
  }

  const executions = new Map<string, RunFileExecution>();
  const files = new Map<string, TFile>();
  const inputs = new Set<string>();
  const artifacts = new Map<string, { actor: RunFileActor; artifact: TArtifact }>();
  const publications = new Map<string, Promise<TFile>>();
  let closed = false;
  let pendingPublications = 0;
  let publicationRevision = 0;
  let pendingRefresh: Promise<void> | undefined;
  let hasLoadedPublications = false;
  executions.set(root.id, structuredClone(root));

  function owns(file: TFile): boolean {
    return file.user === scope.userId && (file.tenantId ?? '') === (scope.tenantId ?? '');
  }

  for (const file of inputFiles) {
    if (!inputFileIds.has(file.file_id) || !owns(file) || inputs.has(file.file_id)) {
      continue;
    }
    inputs.add(file.file_id);
    files.set(file.file_id, structuredClone(file));
  }
  if (files.size > policy.maxFiles) {
    throw new Error('The shared-file manifest exceeds the configured file limit.');
  }

  function close(): void {
    if (closed) return;
    closed = true;
    artifacts.clear();
    files.clear();
    executions.clear();
    publications.clear();
    audit({ action: 'expire', scope, executionId: root.id, fileIds: [] });
  }

  function assertActive(signal?: AbortSignal): void {
    signal?.throwIfAborted();
    if (now() >= createdAt + policy.ttlMs) close();
    if (closed) throw new Error('This shared-file run has expired. Attach the file to a new turn.');
  }

  function executionFor(actor: RunFileActor, signal?: AbortSignal): RunFileExecution {
    assertActive(signal);
    const execution = executions.get(actor.executionId);
    if (!execution?.agentIds.includes(actor.agentId)) {
      throw new Error('This agent execution cannot access the shared-file run.');
    }
    return execution;
  }

  function register(execution: RunFileExecution): void {
    assertActive();
    const parent = execution.parentId == null ? undefined : executions.get(execution.parentId);
    if (
      !execution.id ||
      !parent ||
      !execution.parentAgentId ||
      !parent.agentIds.includes(execution.parentAgentId) ||
      execution.id === parent.id ||
      execution.agentIds.length === 0 ||
      execution.agentIds.some((agentId) => !parent.allowedAgentIds.includes(agentId))
    ) {
      throw new Error('The parent has not authorized this child to receive run files.');
    }
    const existing = executions.get(execution.id);
    if (existing != null) {
      if (JSON.stringify(existing) !== JSON.stringify(execution)) {
        throw new Error('A shared-file execution identity cannot be reassigned.');
      }
      return;
    }
    executions.set(execution.id, structuredClone(execution));
    audit({ action: 'inherit', scope, executionId: execution.id, fileIds: [...inputs] });
  }

  function canRead(actor: RunFileActor, file: TFile): boolean {
    if (inputs.has(file.file_id)) return true;
    const provenance = file.metadata?.runFile;
    if (provenance?.runId !== scope.runId) return false;
    if (actor.executionId === provenance.executionId && actor.agentId === provenance.agentId) {
      return true;
    }
    let parentId = provenance.parentExecutionId;
    let parentAgentId = provenance.parentAgentId;
    const visited = new Set<string>();
    while (parentId != null && !visited.has(parentId)) {
      if (parentId === actor.executionId && parentAgentId === actor.agentId) return true;
      visited.add(parentId);
      const parent = executions.get(parentId);
      parentId = parent?.parentId;
      parentAgentId = parent?.parentAgentId;
    }
    return (
      policy.allowSiblingSharing && provenance.recipientAgentIds?.includes(actor.agentId) === true
    );
  }

  async function refreshFiles(): Promise<void> {
    assertActive();
    hasLoadedPublications = false;
    let published: TFile[];
    let observedRevision: number;
    do {
      observedRevision = publicationRevision;
      published = await store.list(scope);
      assertActive();
    } while (observedRevision !== publicationRevision);
    assertActive();
    const retainedIds = new Set(published.map((file) => file.file_id));
    for (const fileId of files.keys()) {
      if (!inputs.has(fileId) && !retainedIds.has(fileId)) files.delete(fileId);
    }
    for (const file of published) {
      if (
        owns(file) &&
        file.conversationId === scope.conversationId &&
        file.metadata?.runFile?.runId === scope.runId
      ) {
        if (!files.has(file.file_id) && files.size >= policy.maxFiles) {
          throw new Error('The shared-file manifest exceeds the configured file limit.');
        }
        files.set(file.file_id, structuredClone(file));
      }
    }
    hasLoadedPublications = true;
  }

  async function refresh(signal?: AbortSignal): Promise<void> {
    assertActive(signal);
    // Concurrent graph members share the query, but each caller retains its own cancellation.
    pendingRefresh ??= refreshFiles().finally(() => {
      pendingRefresh = undefined;
    });
    await pendingRefresh;
    assertActive(signal);
  }

  async function getFiles(
    actor: RunFileActor,
    signal?: AbortSignal,
    mode: RunFileReadMode = 'refresh',
  ): Promise<TFile[]> {
    executionFor(actor, signal);
    // Unrelated tools reuse the catalog, but must join an in-flight refresh so a
    // newer preparation cannot reinstall a deleted file from an older snapshot.
    if (mode === 'refresh' || !hasLoadedPublications || pendingRefresh != null) {
      await refresh(signal);
    }
    return [...files.values()]
      .filter((file) => canRead(actor, file))
      .map((file) => structuredClone(file));
  }

  async function list(actor: RunFileActor, signal?: AbortSignal): Promise<RunFileEntry[]> {
    return describeRunFiles(await getFiles(actor, signal), scope.runId);
  }

  function stage(actor: RunFileActor, artifact: TArtifact): void {
    executionFor(actor);
    if (!artifact.id || !artifact.filename)
      throw new Error('The generated artifact has no identity.');
    const key = JSON.stringify([actor.executionId, actor.agentId, artifact.id]);
    const existing = artifacts.get(key);
    if (existing && JSON.stringify(existing.artifact) !== JSON.stringify(artifact)) {
      throw new Error('A generated artifact identity cannot be reused for different output.');
    }
    if (!existing && artifacts.size + files.size >= policy.maxFiles) {
      throw new Error('The shared-file manifest exceeds the configured file limit.');
    }
    artifacts.set(key, { actor: { ...actor }, artifact: structuredClone(artifact) });
  }

  function discardArtifacts(actor: RunFileActor): void {
    executionFor(actor);
    for (const [key, staged] of artifacts) {
      if (
        staged.actor.executionId === actor.executionId &&
        staged.actor.agentId === actor.agentId
      ) {
        artifacts.delete(key);
      }
    }
  }

  async function publish(
    actor: RunFileActor,
    artifactId: string,
    recipientAgentIds: string[] = [],
    signal?: AbortSignal,
  ): Promise<TFile> {
    const execution = executionFor(actor, signal);
    const key = JSON.stringify([actor.executionId, actor.agentId, artifactId]);
    const recipients = [...new Set(recipientAgentIds)].sort();
    const knownAgents = new Set<string>();
    for (const entry of executions.values()) {
      for (const agentId of [...entry.agentIds, ...entry.allowedAgentIds]) knownAgents.add(agentId);
    }
    if (
      recipients.length > 0 &&
      (!policy.allowSiblingSharing || recipients.some((agentId) => !knownAgents.has(agentId)))
    ) {
      throw new Error('The sharing policy does not authorize the requested recipients.');
    }
    const existing = publications.get(key);
    if (existing) {
      const file = await existing;
      assertActive(signal);
      if (
        JSON.stringify(file.metadata?.runFile?.recipientAgentIds ?? []) !==
        JSON.stringify(recipients)
      ) {
        throw new Error('A publication cannot be retried with different recipients.');
      }
      return structuredClone(file);
    }
    const publishPromise = (async () => {
      await refresh(signal);
      const restored = [...files.values()].find(
        (file) =>
          file.metadata?.runFile?.executionId === actor.executionId &&
          file.metadata.runFile.agentId === actor.agentId &&
          file.metadata.runFile.sourceFileId === artifactId,
      );
      if (restored) {
        if (
          JSON.stringify(restored.metadata?.runFile?.recipientAgentIds ?? []) !==
          JSON.stringify(recipients)
        ) {
          throw new Error('A publication cannot be retried with different recipients.');
        }
        return restored;
      }
      const staged = artifacts.get(key);
      if (!staged) throw new Error('Only artifacts generated by this execution can be published.');
      if (files.size + pendingPublications >= policy.maxFiles) {
        throw new Error('The shared-file manifest exceeds the configured file limit.');
      }
      pendingPublications++;
      try {
        const provenance: RunFileProvenance = {
          runId: scope.runId,
          executionId: actor.executionId,
          agentId: actor.agentId,
          parentExecutionId: execution.parentId,
          parentAgentId: execution.parentAgentId,
          sourceFileId: artifactId,
          publishedAt: new Date(now()).toISOString(),
          inputFileIds: [...inputs],
          recipientAgentIds: recipients,
        };
        const file = await store.publish({ scope, artifact: staged.artifact, provenance, signal });
        assertActive(signal);
        if (
          !owns(file) ||
          file.conversationId !== scope.conversationId ||
          file.metadata?.runFile?.runId !== scope.runId ||
          file.metadata.runFile.executionId !== actor.executionId ||
          file.metadata.runFile.sourceFileId !== artifactId ||
          file.metadata.runFile.agentId !== actor.agentId ||
          JSON.stringify(file.metadata.runFile.recipientAgentIds ?? []) !==
            JSON.stringify(recipients)
        )
          throw new Error('The artifact store returned a file outside this publication.');
        files.set(file.file_id, structuredClone(file));
        artifacts.delete(key);
        publicationRevision++;
        audit({
          action: 'publish',
          scope,
          ...actor,
          fileIds: [file.file_id],
          recipientAgentIds: recipients,
        });
        return file;
      } finally {
        pendingPublications--;
      }
    })();
    publications.set(key, publishPromise);
    try {
      return structuredClone(await publishPromise);
    } finally {
      publications.delete(key);
    }
  }

  return { register, getFiles, list, stage, discardArtifacts, publish, close };
}
