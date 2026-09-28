import { Constants } from '@librechat/agents';
import { logger } from '@librechat/data-schemas';
import {
  EToolResources,
  getCodeEnvRefForProfile,
  resolveSandboxFilename,
} from 'librechat-data-provider';
import type { AgentToolResources, TFile } from 'librechat-data-provider';
import type { CodeEnvFile } from '@librechat/agents';
import type { CodeEnvRefUpdate, CodeExecutionRoute, ProvisionService } from './service';
import type { ProvisionState } from '~/agents/resources';
import type { ServerRequest } from '~/types';
import {
  claimCodeDestination,
  createCodeDestinationSet,
  reserveCodeDestination,
  sortCodeFilesByDestinationPriority,
} from '~/files/code/destinations';
import { createCodeApiRateLimitBudget, isCodeApiRateLimitError } from '~/utils';
import { getCodeEnvUploadFilename } from '../code/form';
import { isCodeFileToolName } from '~/agents/tools';

/** Deferred database write produced by a successful provisioning call. */
interface FileUpdate {
  file_id: string;
  metadata?: Record<string, unknown>;
  embedded?: boolean;
}

/** One attempt plus one retry: a transient write failure would otherwise leave the record
 *  unprovisioned while the queue is cleared. */
async function persistWithRetry(
  write: () => Promise<unknown>,
  onFailure: (error: unknown) => void,
): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await write();
      return true;
    } catch (error) {
      if (attempt === 1) {
        onFailure(error);
      }
    }
  }
  return false;
}

/** The slice of a per-agent tool context this callback reads and updates. */
export interface ProvisionToolContext {
  provisionState?: ProvisionState;
  tool_resources?: AgentToolResources;
  /** Code API deployment this agent resolved, so uploads land where it will execute. */
  codeExecutionContext?: CodeExecutionRoute;
  /** Successful refs retained while another file in the same batch awaits retry. */
  pendingProvisionedCodeFiles?: CodeEnvFile[];
}

export interface ProvisionCallbackDeps {
  req: ServerRequest;
  agentToolContexts: Map<string, ProvisionToolContext>;
  resolvePrimaryAgentId?: () => string | undefined;
  provisionToCodeEnv: ProvisionService['provisionToCodeEnv'];
  provisionToVectorDB: ProvisionService['provisionToVectorDB'];
  updateFile: (update: FileUpdate) => Promise<unknown>;
  updateCodeEnvRef: (update: CodeEnvRefUpdate) => Promise<unknown>;
  /** Records one vector namespace without disturbing the others already recorded. */
  addEmbeddedEntity: (update: { file_id: string; entityId: string }) => Promise<unknown>;
}

/**
 * Selects the tool context for a provisioning batch and reports which agent id it
 * belongs to. The batch id is preferred, then the primary agent, then the sole context
 * when only one exists, mirroring how the tool loaders resolve theirs.
 *
 */
function resolveProvisionContext({
  agentId,
  agentToolContexts,
  primaryAgentId,
}: {
  agentId?: string;
  agentToolContexts: Map<string, ProvisionToolContext>;
  primaryAgentId?: string;
}): { ctx?: ProvisionToolContext; resolvedAgentId?: string } {
  if (agentId != null && agentToolContexts.has(agentId)) {
    return { ctx: agentToolContexts.get(agentId), resolvedAgentId: agentId };
  }
  if (primaryAgentId != null && agentToolContexts.has(primaryAgentId)) {
    return { ctx: agentToolContexts.get(primaryAgentId), resolvedAgentId: primaryAgentId };
  }
  if (agentToolContexts.size === 1) {
    const sole = agentToolContexts.entries().next().value;
    if (sole) {
      const [key, ctx] = sole;
      return { ctx, resolvedAgentId: key };
    }
  }
  return {};
}

/**
 * Builds the ON_TOOL_EXECUTE provisioning callback. Shared by the chat path and the
 * OpenAI-compatible controllers so every surface provisions queued attachments before
 * the tool that needs them loads.
 */
export function createProvisionFilesCallback({
  req,
  agentToolContexts,
  resolvePrimaryAgentId,
  provisionToCodeEnv,
  provisionToVectorDB,
  updateFile,
  updateCodeEnvRef,
  addEmbeddedEntity,
}: ProvisionCallbackDeps): (
  toolNames: string[],
  agentId?: string,
  signal?: AbortSignal,
) => Promise<CodeEnvFile[]> {
  /* Agents in a handoff or parallel graph are initialized independently over the same
   * request attachments, so each holds its own ProvisionState for the same file. Keyed
   * per file, destination and scope, this makes the upload happen once for the request;
   * every agent still applies the result to its own tool resources below. The shared
   * work includes the database write, because the tools loaded right after this callback
   * re-read the stored record and skip files whose reference is not there yet. */
  const inFlight = new Map<string, Promise<unknown>>();

  function shareProvisioning<T>(key: string | undefined, start: () => Promise<T>): Promise<T> {
    if (key == null) {
      return start();
    }
    const existing = inFlight.get(key) as Promise<T> | undefined;
    if (existing) {
      return existing;
    }
    const promise = start();
    inFlight.set(key, promise);
    /* Forget failures so a later tool call in the same request retries the upload
     * instead of replaying the rejection. */
    promise.catch(() => {
      if (inFlight.get(key) === promise) {
        inFlight.delete(key);
      }
    });
    return promise;
  }

  return async function provisionFiles(
    toolNames: string[],
    agentId?: string,
    signal?: AbortSignal,
  ): Promise<CodeEnvFile[]> {
    signal?.throwIfAborted();
    /* agentId is optional on this callback and a batch for the primary agent may omit
     * it, so fall back the way the tool loaders do. Otherwise the queue is missed and
     * the tool runs without its attachments. */
    /* Resolve the context and the id together. Scoping agent files by the raw argument
     * while reading state from a fallback context would upload them as user-scoped,
     * then reconstruct them as agent-scoped on the next turn, and the entity id used to
     * query those vectors would no longer match the one they were stored under. */
    const { ctx, resolvedAgentId } = resolveProvisionContext({
      agentId,
      agentToolContexts,
      primaryAgentId: resolvePrimaryAgentId?.(),
    });
    if (!ctx?.provisionState) {
      return [];
    }

    const { provisionState } = ctx;
    /** The same set that decides whether an agent wants code-file provisioning at all,
     *  so a tool cannot be eligible in one place and unrecognized in the other. */
    const needsCode = toolNames.some(isCodeFileToolName);
    /** Programmatic tool calling orchestrates nested tools whose names never reach
     *  this predicate, so a file_search reachable only through PTC would otherwise
     *  run before its attachments were embedded. Provision when PTC is invoked. */
    const needsSearch =
      toolNames.includes('file_search') ||
      toolNames.includes(Constants.PROGRAMMATIC_TOOL_CALLING) ||
      toolNames.includes(Constants.BASH_PROGRAMMATIC_TOOL_CALLING);

    if (!needsCode && !needsSearch) {
      return [];
    }

    /** Chat attachments and generated code outputs stay in the user's sandbox and unscoped
     *  vector index; only this agent's own setup files are scoped to it. Membership decides
     *  that, not the record's context: a user may attach another agent's setup file to this
     *  conversation, and provisioning it under this agent would place it in a namespace
     *  this agent's other users can read. */
    const entityIdForFile = (file: TFile) =>
      file.file_id && provisionState.agentScopedFileIds.has(file.file_id)
        ? resolvedAgentId
        : undefined;

    /** Which vector namespace holds the file after this upload. Unscoped uploads are
     *  partitioned by the requesting user, so recording only agent namespaces would leave
     *  a foreign setup file looking unembedded here forever, re-embedding every turn. */
    const namespaceForFile = (file: TFile) => entityIdForFile(file) ?? req?.user?.id;

    /** Two agents may resolve different code deployments, where the same file genuinely
     *  needs uploading to each, so the destination is part of the sharing key. */
    const codeRouteKey =
      ctx.codeExecutionContext?.executionRouteKey ??
      ctx.codeExecutionContext?.executionProfile ??
      'default';
    const shareKey = (resource: string, file: TFile, destination = '') =>
      file.file_id
        ? `${resource}:${file.file_id}:${entityIdForFile(file) ?? ''}:${destination}`
        : undefined;

    /** Surface a just-provisioned file to the tool loaded immediately after: the code
     *  and file_search primers read `tool_resources.<resource>.files`. */
    if (!ctx.tool_resources) {
      ctx.tool_resources = {};
    }
    const addProvisionedFile = (
      file: TFile,
      resourceType: EToolResources,
      agentScoped?: boolean,
    ) => {
      if (!file.file_id) {
        return;
      }
      const toolResources = ctx.tool_resources as Record<
        string,
        { files?: TFile[]; file_ids?: string[] } | undefined
      >;
      const resource = toolResources[resourceType] ?? {};
      /** Agent-scoped file_search files are embedded under `entity_id: agentId`, so
       *  they must be queried by `file_ids` (primeFiles marks those `fromAgent` and
       *  passes `entity_id`); user chat attachments and code files live in `files`. */
      if (agentScoped && resourceType === EToolResources.file_search) {
        const fileIds = resource.file_ids ? [...resource.file_ids] : [];
        if (!fileIds.includes(file.file_id)) {
          fileIds.push(file.file_id);
        }
        toolResources[resourceType] = { ...resource, file_ids: fileIds };
        return;
      }
      const files = resource.files ? [...resource.files] : [];
      if (!files.some((existing) => existing.file_id === file.file_id)) {
        files.push(file);
      }
      toolResources[resourceType] = { ...resource, files };
    };

    /** Files whose provisioning rejected this turn; kept queued so a transient
     *  outage can retry next turn instead of being silently dropped. */
    const failedCodeFiles: TFile[] = [];
    const codeFailureReasons: unknown[] = [];
    const failedVectorFiles: TFile[] = [];
    /* The graph seeded each tool call's code-session context from the sessions that
     * existed at run start, which predate this upload. Returning the refs lets the
     * caller fold them into the current batch, since the sandbox receives files only
     * through that context. */
    const provisionedCodeFiles: CodeEnvFile[] = needsCode
      ? [...(ctx.pendingProvisionedCodeFiles ?? [])]
      : [];
    if (needsCode && provisionState.codeEnvFiles.length > 0) {
      const queuedFileIds = new Set(provisionState.codeEnvFiles.map((file) => file.file_id));
      const liveFiles =
        (ctx.tool_resources as Record<string, { files?: TFile[] } | undefined>)[
          EToolResources.execute_code
        ]?.files ?? [];
      const routePrivateFileIds = new Set<string>();
      for (const candidate of agentToolContexts.values()) {
        const route =
          candidate.codeExecutionContext?.executionRouteKey ??
          candidate.codeExecutionContext?.executionProfile ??
          'default';
        if (route !== codeRouteKey) continue;
        for (const id of candidate.provisionState?.agentScopedFileIds ?? [])
          routePrivateFileIds.add(id);
      }
      const confirmedDestinations = new Set<string>();
      const queuedCodeFiles = sortCodeFilesByDestinationPriority(
        [
          ...provisionState.codeEnvFiles,
          ...liveFiles.filter((file) => !queuedFileIds.has(file.file_id)),
        ],
        routePrivateFileIds,
      )
        .filter((file): file is TFile => {
          if (!file) return false;
          const ref = getCodeEnvRefForProfile(file.metadata, codeRouteKey);
          const recovery = provisionState.codeEnvRecoveryNames?.get(file.file_id);
          const entityId = entityIdForFile(file);
          const isTargetScope =
            ref != null &&
            ref.kind === (entityId ? 'agent' : 'user') &&
            ref.id === (entityId ?? req.user?.id);
          let storedName = recovery?.isTargetScope ? recovery.name : undefined;
          if (isTargetScope) storedName = ref?.sandboxFilename;
          // Prefix conflicts are independent recoverable inputs; only equal stored paths
          // identify superseded content. Foreign-scope refs are claimable hints too.
          if (storedName == null) return true;
          if (confirmedDestinations.has(storedName)) return false;
          confirmedDestinations.add(storedName);
          return true;
        })
        .filter((file) => queuedFileIds.has(file.file_id));
      /** Every file in this tool-load batch shares one wait allowance. This
       *  prevents a large recovery set from multiplying the live-turn delay. */
      const codeApiRateLimitBudget = createCodeApiRateLimitBudget(
        req.config?.endpoints?.agents?.codeApiMaxRetryWaitMs,
      );
      const destinations = createCodeDestinationSet();
      // Live storage paths are immutable. Reserve the same route-wide set for every
      // agent so private live resources cannot give a shared recovery divergent names.
      for (const candidateContext of agentToolContexts.values()) {
        const candidateRoute =
          candidateContext.codeExecutionContext?.executionRouteKey ??
          candidateContext.codeExecutionContext?.executionProfile ??
          'default';
        if (candidateRoute !== codeRouteKey) continue;
        const existingCodeFiles = (
          candidateContext.tool_resources as
            | Record<string, { files?: TFile[] } | undefined>
            | undefined
        )?.[EToolResources.execute_code]?.files;
        for (const existing of existingCodeFiles ?? []) {
          if (queuedFileIds.has(existing.file_id)) continue;
          reserveCodeDestination(
            destinations,
            getCodeEnvRefForProfile(existing.metadata, codeRouteKey)?.sandboxFilename ??
              resolveSandboxFilename(existing.filename, existing.type),
          );
        }
      }
      for (const existing of provisionedCodeFiles) {
        claimCodeDestination(destinations, existing.name, existing.id);
      }
      const results = await Promise.allSettled(
        queuedCodeFiles.map(async (file) => {
          const sandboxFilename = claimCodeDestination(
            destinations,
            getCodeEnvUploadFilename(
              resolveSandboxFilename(
                getCodeEnvRefForProfile(file.metadata, codeRouteKey)?.sandboxFilename ??
                  provisionState.codeEnvRecoveryNames?.get(file.file_id)?.name ??
                  file.filename,
                file.type,
              ),
            ),
            file.file_id,
          );
          const provisioned = await shareProvisioning(
            shareKey(`code:${codeRouteKey}`, file, sandboxFilename),
            async () => {
              const {
                referenceSet: refs,
                refUpdate,
                sandboxFilename: storedSandboxFilename,
              } = await provisionToCodeEnv({
                req,
                file,
                entity_id: entityIdForFile(file),
                route: ctx.codeExecutionContext,
                sandboxFilename,
                signal,
                rateLimitBudget: codeApiRateLimitBudget,
              });
              signal?.throwIfAborted();
              /* primeCodeFiles re-reads the database and skips files without a stored
               * reference, so a tool loaded after an unpersisted upload would run against
               * an attachment it cannot see. Fail instead of answering from missing input. */
              const persisted = await persistWithRetry(
                () => updateCodeEnvRef(refUpdate),
                (error) =>
                  logger.error(
                    `[provisionFiles] Failed to persist code environment reference for file ${refUpdate.file_id}`,
                    error,
                  ),
              );
              if (!persisted) {
                throw new Error(
                  `Failed to persist the code environment reference for file ${refUpdate.file_id}`,
                );
              }
              return { refs, sandboxFilename: storedSandboxFilename };
            },
          );
          const { refs: referenceSet, sandboxFilename: returnedSandboxFilename } = provisioned;
          file.metadata = { ...file.metadata, ...referenceSet };
          addProvisionedFile(file, EToolResources.execute_code);
          const ref = referenceSet.codeEnvRefs?.[codeRouteKey];
          if (ref?.storage_session_id && ref.file_id) {
            const codeFile = {
              id: ref.file_id,
              resource_id: ref.id,
              storage_session_id: ref.storage_session_id,
              /* The name the sandbox stored it under: a converted image is renamed on
               * upload, and telling the model the record's name sends it to a path that
               * does not exist. */
              name: returnedSandboxFilename,
              kind: ref.kind,
            } as CodeEnvFile;
            const existingIndex = provisionedCodeFiles.findIndex(
              (existing) => existing.id === codeFile.id && existing.name === codeFile.name,
            );
            if (existingIndex >= 0) {
              provisionedCodeFiles[existingIndex] = codeFile;
            } else {
              provisionedCodeFiles.push(codeFile);
            }
          }
        }),
      );
      /* allSettled keeps independent file failures retryable, but cancellation belongs
       * to the whole tool run. Preserve it before translating rejections into queued
       * files or starting search provisioning. */
      signal?.throwIfAborted();
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          logger.error('[provisionFiles] Code env provisioning failed', result.reason);
          failedCodeFiles.push(queuedCodeFiles[index]);
          codeFailureReasons.push(result.reason);
        }
      });
      provisionState.codeEnvFiles = failedCodeFiles;
      if (provisionedCodeFiles.length > 0) {
        ctx.pendingProvisionedCodeFiles = provisionedCodeFiles;
      }
    }

    if (needsSearch && provisionState.vectorDBFiles.length > 0) {
      const queuedVectorFiles = provisionState.vectorDBFiles;
      const results = await Promise.allSettled(
        queuedVectorFiles.map(async (file) => {
          const result = await shareProvisioning(shareKey('search', file), async () => {
            const provisioned = await provisionToVectorDB({
              req,
              file,
              entity_id: entityIdForFile(file),
              signal,
            });
            signal?.throwIfAborted();
            /* The vectors are already stored, so a failed flag write costs a re-embed next
             * turn rather than this turn's results. Logged, not fatal. */
            if (provisioned.embedded && provisioned.fileUpdate) {
              const update = provisioned.fileUpdate;
              /* Vectors live under the entity that provisioned them, so the namespace is
               * recorded alongside the flag. Agents sharing a record, as a duplicate does
               * with its source, each need their own embedding, and an unscoped upload
               * lands in the user's namespace rather than in none. */
              const namespace = namespaceForFile(file);
              await persistWithRetry(
                () =>
                  namespace != null
                    ? addEmbeddedEntity({ file_id: update.file_id, entityId: namespace })
                    : updateFile(update),
                (error) =>
                  logger.error(
                    `[provisionFiles] Failed to persist embedding state for file ${update.file_id}`,
                    error,
                  ),
              );
            }
            return provisioned;
          });
          if (result.embedded) {
            file.embedded = true;
            const namespace = namespaceForFile(file);
            if (namespace != null) {
              const recorded = new Set(file.metadata?.embeddedEntities ?? []);
              recorded.add(namespace);
              file.metadata = { ...file.metadata, embeddedEntities: [...recorded] };
            }
            addProvisionedFile(
              file,
              EToolResources.file_search,
              entityIdForFile(file) !== undefined,
            );
            return;
          }
          /* Resolving with embedded false is a normal outcome of the service, returned
           * when the vector store declines the file, and it means the same thing as a
           * throw: the vectors are not there. Treated as a failure so the file stays
           * queued and search does not proceed without it. */
          throw new Error(`Vector store did not embed "${file.filename}" (${file.file_id})`);
        }),
      );
      signal?.throwIfAborted();
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          logger.error('[provisionFiles] Vector DB provisioning failed', result.reason);
          failedVectorFiles.push(queuedVectorFiles[index]);
        }
      });
      /* Preserved for a later retry, and fatal for this turn like a code failure. An
       * earlier version let search proceed on the grounds that a missing embedding only
       * narrows results, but a search that silently omits the file the user asked about
       * is a wrong answer, not a smaller one. */
      provisionState.vectorDBFiles = failedVectorFiles;
    }

    /* Provisioning failed outright, so the sandbox or vector store does not have the
     * attachment; running the tool anyway would answer from missing input. */
    if (failedCodeFiles.length > 0) {
      if (codeFailureReasons.length > 0 && codeFailureReasons.every(isCodeApiRateLimitError)) {
        throw codeFailureReasons[0];
      }
      throw Object.assign(
        new Error(
          `Failed to provision ${failedCodeFiles.length} file(s) to the code environment; aborting tool execution rather than running without them`,
          codeFailureReasons[0] !== undefined ? { cause: codeFailureReasons[0] } : undefined,
        ),
        { errors: codeFailureReasons },
      );
    }
    if (failedVectorFiles.length > 0) {
      throw new Error(
        `Failed to provision ${failedVectorFiles.length} file(s) for search; aborting tool execution rather than searching without them`,
      );
    }

    if (needsCode) {
      ctx.pendingProvisionedCodeFiles = undefined;
    }
    return provisionedCodeFiles;
  };
}
