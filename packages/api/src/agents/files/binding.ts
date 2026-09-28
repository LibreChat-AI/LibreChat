import { agentsEndpointSchema } from 'librechat-data-provider';
import type { CodeEnvFile, SubagentExecutionContext } from '@librechat/agents';
import type { TFile } from 'librechat-data-provider';
import type { PublishedCodeOutputResult } from '~/files/code/publication';
import type { ServerRequest, StrategyFunctions } from '~/types';
import type { CodeExecutionContext } from '~/agents/execution';
import type { RunFileMessageEncoderDeps } from './encode';
import type { ToolEndCallback } from '~/agents/handlers';
import type { RunFileHost } from './host';
import { createRunArtifactSnapshotAdapter } from '~/files/code/snapshot';
import { createRunArtifactPublisher } from '~/files/code/publication';
import { createRunFileSnapshotStore } from './snapshots';
import { createRunFileMessageEncoder } from './encode';
import { createRunFileHost } from './host';

type HostOptions = Parameters<typeof createRunFileHost>[0];
type PublisherOptions = Parameters<typeof createRunArtifactPublisher>[0];

type ProvisionCallback = (
  names: string[],
  agentId?: string,
  signal?: AbortSignal,
) => Promise<CodeEnvFile[] | void>;

export interface ChatRunFileBindings extends RunFileHost {
  getCodeExecutionContext: (
    agentId: string,
    context?: SubagentExecutionContext,
  ) => CodeExecutionContext | undefined;
  wrapProvision: (
    fallback: ProvisionCallback,
  ) => (
    names: string[],
    agentId?: string,
    signal?: AbortSignal,
    context?: SubagentExecutionContext,
  ) => Promise<CodeEnvFile[] | void>;
  wrapToolEnd: (fallback: ToolEndCallback) => ToolEndCallback;
}

/** Binds the existing storage, preview, and SSE adapters without giving shared files another pipeline. */
export function createChatRunFileBindings({
  req,
  contexts,
  createdAt = Date.now(),
  audit,
  requestFiles,
  getInputs,
  loadFiles,
  filterFiles,
  listPublications,
  provisioning,
  fileMethods,
  processCodeOutput,
  snapshotAdapter,
  finalize,
  encoder,
  getStrategyFunctions,
  artifactPromises,
  emitAttachment,
}: {
  req: ServerRequest;
  contexts: HostOptions['contexts'];
  createdAt?: number;
  audit?: HostOptions['audit'];
  requestFiles: readonly { file_id?: string }[];
  getInputs: HostOptions['getInputs'];
  loadFiles: HostOptions['loadFiles'];
  filterFiles: HostOptions['filterFiles'];
  listPublications: HostOptions['listPublications'];
  provisioning: HostOptions['provisioning'];
  fileMethods: Pick<
    PublisherOptions,
    'claimRunArtifactFile' | 'publishRunArtifactFile' | 'findRunArtifactFile'
  >;
  processCodeOutput: (
    input: Parameters<PublisherOptions['processCodeOutput']>[0] & { req: ServerRequest },
  ) => ReturnType<PublisherOptions['processCodeOutput']>;
  snapshotAdapter: Omit<Parameters<typeof createRunArtifactSnapshotAdapter>[0], 'req'>;
  finalize: (input: {
    finalize?: PublishedCodeOutputResult['finalize'];
    fileId?: string;
    previewRevision?: string;
  }) => void;
  encoder: Omit<RunFileMessageEncoderDeps, 'req' | 'getStrategyFunctions'>;
  getStrategyFunctions: (source: string) => StrategyFunctions;
  artifactPromises: Array<Promise<TFile | null>>;
  emitAttachment: (file: TFile) => void;
}): ChatRunFileBindings {
  const policy =
    req.config?.endpoints?.agents?.fileSharing ??
    agentsEndpointSchema.parse({ fileSharing: {} }).fileSharing!;
  const adapter = createRunArtifactSnapshotAdapter({ ...snapshotAdapter, req });
  const snapshots = createRunFileSnapshotStore({
    open: adapter.open,
    maxBytes: policy.maxPrivateBytes,
    // One temporary comparison slot lets unchanged read results deduplicate even
    // at catalog capacity. The manifest still enforces the configured file count.
    maxFiles: policy.maxFiles + 1,
  });
  const publishArtifact = createRunArtifactPublisher({
    ...fileMethods,
    processCodeOutput: (input) => processCodeOutput({ ...input, req }),
    prepare: async (artifact, signal) => {
      if (!artifact.snapshotId)
        throw new Error(
          'The private output snapshot is unavailable. Regenerate the file before publishing.',
        );
      const buffer = await snapshots.read(artifact.snapshotId, signal);
      return adapter.prepare(artifact, buffer, signal);
    },
    discard: async (file) => {
      const strategy = getStrategyFunctions(file.source ?? 'local');
      if (!strategy.deleteFile) throw new Error('The artifact storage does not support cleanup.');
      await strategy.deleteFile(req, file);
    },
    finalize: (result) =>
      finalize({
        finalize: result.finalize,
        fileId: result.file?.file_id,
        previewRevision: result.previewRevision,
      }),
  });
  const emitted = new Set<string>();
  const messageEncoder = createRunFileMessageEncoder({ ...encoder, req, getStrategyFunctions });
  const host = createRunFileHost({
    req,
    contexts,
    createdAt,
    audit,
    getInputs,
    loadFiles,
    filterFiles,
    listPublications,
    snapshots,
    provisioning,
    inputFileIds: new Set(requestFiles.flatMap((file) => (file.file_id ? [file.file_id] : []))),
    validateMessages: messageEncoder.validate,
    encodeMessages: messageEncoder.encode,
    publish: async ({ scope, artifact, provenance, signal }) => {
      signal?.throwIfAborted();
      const file = await publishArtifact({
        scope: {
          ...scope,
          executionId: provenance.executionId,
          agentId: provenance.agentId,
          sourceFileId: provenance.sourceFileId,
        },
        artifact,
        provenance,
        signal,
      });
      signal?.throwIfAborted();
      return file;
    },
    emit: async (file) => {
      if (!emitted.has(file.file_id)) {
        artifactPromises.push(Promise.resolve(file));
        emitted.add(file.file_id);
      }
      emitAttachment(file);
    },
  });

  return {
    ...host,
    getCodeExecutionContext: (agentId: string, context?: Parameters<typeof host.getContext>[1]) =>
      host.session.isActive() ? host.getContext(agentId, context)?.codeExecutionContext : undefined,
    wrapProvision:
      (fallback: ProvisionCallback) =>
      async (
        names: string[],
        agentId?: string,
        signal?: AbortSignal,
        context?: Parameters<typeof host.getContext>[1],
      ) => {
        if (!host.session.isActive()) return fallback(names, agentId, signal);
        if (!agentId || !signal)
          throw new Error('Shared-file provisioning requires an execution identity.');
        return host.provisionPrepared(names, agentId, signal, context);
      },
    wrapToolEnd:
      (fallback: ToolEndCallback): ToolEndCallback =>
      (data, metadata) =>
        host.deliverToolEnd(fallback, data, metadata),
  };
}
