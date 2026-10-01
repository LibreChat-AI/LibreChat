import { EToolResources, getCodeEnvRefs } from 'librechat-data-provider';
import type { CodeEnvFile, SubagentExecutionContext } from '@librechat/agents';
import type { Agent, TFile } from 'librechat-data-provider';
import type { ProvisionCallbackDeps, ProvisionToolContext } from '~/files/provision/callback';
import type { ToolEndCallback, ToolEndCallbackMetadata } from '~/agents/handlers';
import type { TFilterFilesByAgentAccess } from '~/agents/resources';
import type { RunFileSession, RunFileSessionDeps } from './session';
import type { CodeExecutionContext } from '~/agents/execution';
import type { ServerRequest } from '~/types';
import { isCodeArtifactToolOutput, isCodeFileToolName } from '~/agents/tools';
import { createProvisionFilesCallback } from '~/files/provision/callback';
import { assertModelBoundContent } from '~/middleware/modelBoundContent';
import { addFileToResource, primeResources } from '~/agents/resources';
import { filterFilesByEndpointRuntimeConfig } from '~/files/filter';
import { resolveResendToolResources } from '~/agents/initialize';
import { createRunFileSession } from './session';

export interface RunFileToolContext extends ProvisionToolContext {
  agent?: Agent;
  codeEnvAvailable?: boolean;
  codeExecutionContext?: CodeExecutionContext;
}

export interface RunFileHost<TContext extends RunFileToolContext = RunFileToolContext> {
  session: RunFileSession;
  getContext: (
    agentId: string,
    executionContext?: SubagentExecutionContext,
  ) => TContext | undefined;
  provision: (
    toolNames: string[],
    agentId: string,
    signal: AbortSignal,
    executionContext?: SubagentExecutionContext,
  ) => Promise<CodeEnvFile[] | undefined>;
  /** Used immediately after the handler has authorized the current tool batch. */
  provisionPrepared: (
    toolNames: string[],
    agentId: string,
    signal: AbortSignal,
    executionContext?: SubagentExecutionContext,
  ) => Promise<CodeEnvFile[] | undefined>;
  deliverToolEnd: (
    callback: ToolEndCallback,
    data: Parameters<ToolEndCallback>[0],
    metadata: ToolEndCallbackMetadata,
  ) => Promise<void>;
}

/** Overrides only the session identity; deployments and credentials remain host-resolved. */
export function resolveRunFileCodeExecutionContext(
  resolved: CodeExecutionContext,
  shared?: CodeExecutionContext,
): CodeExecutionContext {
  if (shared == null) return resolved;
  if (
    resolved.baseUrl !== shared.baseUrl ||
    resolved.executionProfile !== shared.executionProfile ||
    resolved.executionRouteKey !== shared.executionRouteKey ||
    resolved.environmentId !== shared.environmentId ||
    resolved.bridgeWorkerId !== shared.bridgeWorkerId ||
    resolved.environmentType === 'attached'
  ) {
    throw new Error('The shared-file execution environment changed during this run.');
  }
  return {
    ...resolved,
    codeSessionKey: shared.codeSessionKey,
    runtimeSessionHint: shared.runtimeSessionHint,
  };
}

export function createRunFileHost<TContext extends RunFileToolContext>({
  req,
  contexts,
  createdAt,
  inputFileIds,
  getInputs,
  loadFiles,
  filterFiles,
  validateMessages,
  encodeMessages,
  listPublications,
  snapshots,
  publish,
  emit,
  audit,
  provisioning,
}: {
  req: ServerRequest;
  contexts: Map<string, TContext>;
  createdAt: number;
  inputFileIds: ReadonlySet<string>;
  getInputs: () => readonly TFile[];
  loadFiles: (fileIds: string[]) => Promise<TFile[]>;
  filterFiles: TFilterFilesByAgentAccess;
  validateMessages: RunFileSessionDeps['validateMessages'];
  encodeMessages: RunFileSessionDeps['encodeMessages'];
  listPublications: RunFileSessionDeps['listPublications'];
  snapshots: RunFileSessionDeps['snapshots'];
  publish: RunFileSessionDeps['publish'];
  emit: RunFileSessionDeps['emit'];
  audit?: RunFileSessionDeps['audit'];
  provisioning: Pick<
    ProvisionCallbackDeps,
    | 'provisionToCodeEnv'
    | 'provisionToVectorDB'
    | 'updateFile'
    | 'updateCodeEnvRef'
    | 'addEmbeddedEntity'
  >;
}): RunFileHost<TContext> {
  const user = req.user;
  if (user == null) throw new Error('Run file sharing requires an authenticated user.');
  const executionContexts = new Map<string, TContext>();
  const prepared = new Map<
    string,
    {
      revision: number;
      signature: string;
      files: Map<string, TFile>;
      setupFiles: Map<string, TFile>;
      loadedSetupIds: Set<string>;
    }
  >();
  const provisioningCallbacks = new Map<string, ReturnType<typeof createProvisionFilesCallback>>();
  const operations = new Map<string, Promise<unknown>>();

  /** Priming and tool provisioning both mutate these queues. Other executions, even of
   * the same configured agent, have independent queues and can make progress together. */
  function serialize<T>(key: string, signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    const previous = operations.get(key) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => {
        signal.throwIfAborted();
        return operation();
      });
    operations.set(key, current);
    const release = () => {
      if (operations.get(key) === current) operations.delete(key);
    };
    void current.then(release, release);
    return current;
  }

  function retainContext(key: string, agentId: string, context: TContext): void {
    executionContexts.set(key, context);
    if (!provisioningCallbacks.has(key)) {
      provisioningCallbacks.set(
        key,
        createProvisionFilesCallback({
          req,
          agentToolContexts: new Map([[agentId, context]]),
          ...provisioning,
        }),
      );
    }
  }
  const session = createRunFileSession({
    policy: req.config?.endpoints?.agents?.fileSharing,
    userId: user.id,
    tenantId: user.tenantId,
    createdAt,
    inputFileIds,
    getInputs,
    getAgent: (agentId) => contexts.get(agentId)?.agent,
    listPublications,
    snapshots,
    publish,
    emit,
    audit,
    validateMessages,
    encodeMessages,
    prepareAgent: async ({ actor, files, revision, sessionKey, signal }) => {
      const key = JSON.stringify(actor);
      await serialize(key, signal, async () => {
        const previous = prepared.get(key);
        // Snapshots are numbered before their asynchronous reads. A late older read
        // cannot restore a removed grant or replace a newer actor's queues.
        if (previous != null && revision <= previous.revision) return;
        const source = contexts.get(actor.agentId);
        if (!source?.agent) throw new Error('The shared-file agent is no longer available.');
        const isRoot = actor.executionId === session.actorFor(actor.agentId).executionId;
        if (!isRoot && source.codeExecutionContext?.environmentType === 'attached') {
          throw new Error('Run file sharing requires an isolated managed code environment.');
        }
        const screen = (candidates: TFile[], consumedBytes = 0): TFile[] => {
          const admitted = filterFilesByEndpointRuntimeConfig(req.config, {
            files: candidates,
            endpoint: source.agent!.endpoint ?? source.agent!.provider ?? 'agents',
            preserveTextSources: true,
            consumedBytes,
          });
          if (admitted.length !== candidates.length) {
            throw new Error('A shared file is not supported by the receiving agent.');
          }
          assertModelBoundContent({ filters: req.config?.filters, files: admitted });
          return admitted;
        };
        const signature = JSON.stringify(files.map((file) => file.file_id).sort());
        const existingContext = executionContexts.get(key);
        if (isRoot) {
          // The root already passed normal conversation authorization and priming.
          // Sharing only limits what descendants inherit; its own historical files,
          // pending uploads and runtime session must survive activation and refresh.
          const context = existingContext ?? source;
          const existingFiles = new Map(
            [
              ...Object.values(context.tool_resources ?? {}).flatMap(
                (resource) => resource?.files ?? [],
              ),
              ...(context.provisionState?.codeEnvFiles ?? []),
              ...(context.provisionState?.vectorDBFiles ?? []),
              ...(previous?.files.values() ?? []),
            ].map((file) => [file.file_id, file]),
          );
          const currentIds = new Set(files.map((file) => file.file_id));
          let consumedBytes = 0;
          for (const file of existingFiles.values()) {
            if (!currentIds.has(file.file_id) && !previous?.files.has(file.file_id)) {
              consumedBytes += file.bytes;
            }
          }
          screen(files, consumedBytes);
          if (previous?.signature === signature) {
            previous.revision = revision;
            return;
          }
          const currentFiles = files.map(
            (file) => existingFiles.get(file.file_id) ?? structuredClone(file),
          );
          const removed = new Set(
            [...(previous?.files.keys() ?? [])].filter((id) => !currentIds.has(id)),
          );
          const added = currentFiles.filter((file) => !existingFiles.has(file.file_id));
          const primed = await primeResources({
            req,
            appConfig: req.config,
            agentId: actor.agentId,
            attachments: Promise.resolve(added),
            requestFileSet: new Set(added.map((file) => file.file_id)),
            tool_resources: undefined,
            getFiles: async () => [],
            enabledToolResources: resolveResendToolResources({
              tools: source.agent.tools ?? [],
              codeEnvAvailable: source.codeEnvAvailable === true,
            }),
            codeRouteKey:
              context.codeExecutionContext?.executionRouteKey ??
              context.codeExecutionContext?.executionProfile,
            codeBaseUrl: context.codeExecutionContext?.baseUrl,
          });
          signal.throwIfAborted();
          const resources = context.tool_resources ?? {};
          for (const resource of Object.values(resources)) {
            if (resource?.files)
              resource.files = resource.files.filter((file: TFile) => !removed.has(file.file_id));
            if (resource?.file_ids)
              resource.file_ids = resource.file_ids.filter((id: string) => !removed.has(id));
          }
          const processedResourceFiles = new Set<string>();
          for (const [type, resource] of Object.entries(primed.tool_resources ?? {})) {
            for (const file of resource?.files ?? [])
              addFileToResource({
                file,
                resourceType: type as EToolResources,
                tool_resources: resources,
                processedResourceFiles,
              });
          }
          context.tool_resources = resources;
          const state = context.provisionState ?? primed.provisionState;
          if (state) {
            const merge = (existing: TFile[], incoming: TFile[]) => [
              ...new Map(
                [...existing.filter((file) => !removed.has(file.file_id)), ...incoming].map(
                  (file) => [file.file_id, file],
                ),
              ).values(),
            ];
            state.codeEnvFiles = merge(
              state.codeEnvFiles,
              primed.provisionState?.codeEnvFiles ?? [],
            );
            state.vectorDBFiles = merge(
              state.vectorDBFiles,
              primed.provisionState?.vectorDBFiles ?? [],
            );
            context.provisionState = state;
          }
          const removedCodeIds = new Set(
            [...removed].flatMap((id) =>
              getCodeEnvRefs(previous?.files.get(id)?.metadata).map(([, ref]) => ref.file_id),
            ),
          );
          context.pendingProvisionedCodeFiles = context.pendingProvisionedCodeFiles?.filter(
            (file) => !removedCodeIds.has(file.id),
          );
          retainContext(key, actor.agentId, context);
          prepared.set(key, {
            revision,
            signature,
            files: new Map(currentFiles.map((file) => [file.file_id, file])),
            setupFiles: new Map(),
            loadedSetupIds: new Set(),
          });
          return;
        }
        screen(files);
        const codeExecutionContext =
          source.codeExecutionContext == null
            ? undefined
            : resolveRunFileCodeExecutionContext(source.codeExecutionContext, {
                ...source.codeExecutionContext,
                codeSessionKey: sessionKey,
                runtimeSessionHint: sessionKey,
              });
        if (codeExecutionContext && existingContext?.codeExecutionContext) {
          resolveRunFileCodeExecutionContext(
            codeExecutionContext,
            existingContext.codeExecutionContext,
          );
        }
        if (previous?.signature === signature) {
          previous.revision = revision;
          return;
        }
        // Unified input records are immutable for this run. Keep this actor's local
        // provisioning results, which may be newer than a manifest or database read.
        const currentFiles = files.map(
          (file) => previous?.files.get(file.file_id) ?? structuredClone(file),
        );
        const setupFiles = previous?.setupFiles ?? new Map<string, TFile>();
        const loadedSetupIds = previous?.loadedSetupIds ?? new Set<string>();
        const admittedSetupIds = new Set<string>();
        let failed: { error: unknown } | undefined;
        const primed = await primeResources({
          req,
          appConfig: req.config,
          agentId: actor.agentId,
          attachments: Promise.resolve(currentFiles),
          requestFileSet: new Set(currentFiles.map((file) => file.file_id)),
          tool_resources: source.agent.tool_resources,
          enabledToolResources: resolveResendToolResources({
            tools: source.agent.tools ?? [],
            codeEnvAvailable: source.codeEnvAvailable === true,
          }),
          getFiles: async (filter) => {
            try {
              const ids = (filter as { file_id: { $in: string[] } }).file_id.$in;
              const missing = ids.filter((id) => !loadedSetupIds.has(id));
              if (missing.length > 0) {
                const loaded = await loadFiles(missing);
                const requested = new Set(missing);
                for (const file of loaded) {
                  if (requested.has(file.file_id))
                    setupFiles.set(file.file_id, structuredClone(file));
                }
                for (const id of missing) loadedSetupIds.add(id);
              }
              return ids.flatMap((id) => {
                const file = setupFiles.get(id);
                return file ? [file] : [];
              });
            } catch (error) {
              failed = { error };
              throw error;
            }
          },
          filterFiles: async (params) => {
            try {
              return await filterFiles(params);
            } catch (error) {
              failed = { error };
              throw error;
            }
          },
          codeRouteKey:
            codeExecutionContext?.executionRouteKey ?? codeExecutionContext?.executionProfile,
          codeBaseUrl: codeExecutionContext?.baseUrl,
          screenPersistentFiles: (candidates) => {
            try {
              const candidateIds = new Set(candidates.map((file) => file.file_id));
              const consumedBytes = currentFiles.reduce(
                (total, file) => total + (candidateIds.has(file.file_id) ? 0 : file.bytes),
                0,
              );
              const admitted = screen(candidates, consumedBytes);
              for (const file of admitted) admittedSetupIds.add(file.file_id);
              return admitted;
            } catch (error) {
              failed = { error };
              throw error;
            }
          },
        });
        // primeResources supports a best-effort legacy caller. A shared-file host
        // must fail closed when its authorized resource load or policy check fails.
        if (failed) throw failed.error;
        signal.throwIfAborted();
        const admittedIds = new Set([
          ...currentFiles.map((file) => file.file_id),
          ...admittedSetupIds,
        ]);
        for (const resource of Object.values(primed.tool_resources ?? {})) {
          if (resource?.file_ids) {
            resource.file_ids = resource.file_ids.filter((id: string) => admittedIds.has(id));
          }
        }
        const provisionState =
          primed.provisionState ??
          (existingContext?.provisionState
            ? {
                ...existingContext.provisionState,
                codeEnvFiles: [],
                vectorDBFiles: [],
                codeEnvRecoveryNames: undefined,
              }
            : undefined);
        if (provisionState) provisionState.agentScopedFileIds = admittedSetupIds;
        const context: TContext = existingContext ?? {
          ...source,
          pendingProvisionedCodeFiles: undefined,
        };
        context.tool_resources = primed.tool_resources;
        context.provisionState = provisionState;
        context.codeExecutionContext = codeExecutionContext;
        if (context.pendingProvisionedCodeFiles) {
          const currentCodeIds = new Set(
            [
              ...currentFiles,
              ...[...admittedSetupIds].flatMap((id) => setupFiles.get(id) ?? []),
            ].flatMap((file) => getCodeEnvRefs(file.metadata).map(([, ref]) => ref.file_id)),
          );
          context.pendingProvisionedCodeFiles = context.pendingProvisionedCodeFiles.filter((file) =>
            currentCodeIds.has(file.id),
          );
        }
        retainContext(key, actor.agentId, context);
        prepared.set(key, {
          revision,
          signature,
          files: new Map(currentFiles.map((file) => [file.file_id, file])),
          setupFiles,
          loadedSetupIds,
        });
      });
    },
  });

  function getContext(
    agentId: string,
    executionContext?: SubagentExecutionContext,
  ): TContext | undefined {
    if (!session.isActive()) return contexts.get(agentId);
    return executionContexts.get(JSON.stringify(session.actorFor(agentId, executionContext)));
  }

  async function provision(
    toolNames: string[],
    agentId: string,
    signal: AbortSignal,
    executionContext?: SubagentExecutionContext,
  ) {
    if (!session.isActive()) return undefined;
    await session.prepareTools(agentId, executionContext, signal);
    return provisionPrepared(toolNames, agentId, signal, executionContext);
  }

  async function provisionPrepared(
    toolNames: string[],
    agentId: string,
    signal: AbortSignal,
    executionContext?: SubagentExecutionContext,
  ): Promise<CodeEnvFile[] | undefined> {
    if (!session.isActive()) return undefined;
    const key = JSON.stringify(session.actorFor(agentId, executionContext));
    if (!prepared.has(key)) throw new Error('The shared-file execution has not been prepared.');
    return serialize(key, signal, async () =>
      provisioningCallbacks.get(key)?.(toolNames, agentId, signal),
    );
  }

  const deliverToolEnd = async (
    callback: ToolEndCallback,
    data: Parameters<ToolEndCallback>[0],
    metadata: ToolEndCallbackMetadata,
  ): Promise<void> => {
    const executionContext = metadata.executionContext as SubagentExecutionContext | undefined;
    if (!session.isActive() || executionContext == null) return callback(data, metadata);
    if (!isCodeArtifactToolOutput(data.output) && !isCodeFileToolName(data.output.name)) {
      return callback(data, metadata);
    }
    const agentId = metadata.executingAgentId ?? metadata.agentId ?? metadata.agent_id;
    if (typeof agentId !== 'string')
      throw new Error('The shared-file producer has no agent identity.');
    const context = getContext(agentId, executionContext);
    if (!context) throw new Error('The shared-file producer has no execution context.');
    if (data.output.artifact == null || typeof data.output.artifact !== 'object') return;
    await session.capture(
      agentId,
      executionContext,
      data.output.tool_call_id,
      data.output.artifact as Parameters<typeof session.capture>[3],
      context.codeExecutionContext,
    );
  };

  return { session, getContext, provision, provisionPrepared, deliverToolEnd };
}
