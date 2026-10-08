import type { DeleteFilesResponse } from 'librechat-data-provider';

/** What a delete pass reports back about the records it was given. */
export type FileDeletionOutcome = {
  deletedFileIds?: string[];
  failedFileIds?: string[];
};

/** The `{ tool_resource, file_id }` pair an agent resource unlink takes. */
export type AgentResourceFileRef = {
  tool_resource: string;
  file_id: string;
};

/**
 * One requested file, as this module needs to see it: an id, an owner already normalized to a
 * plain string by the caller, and the opaque record the delete pass will be handed. Ownership
 * arrives as a string so no storage type crosses into this package.
 */
export type AgentResourceFileInput<TFile> = {
  file_id: string;
  owner: string | null;
  file: TFile;
};

export type AgentResourceDeletion<TFile> = {
  /** Attached files the caller owns: candidates for storage, vector and metadata deletion. */
  ownedFiles: Array<AgentResourceFileInput<TFile>>;
  /** Attached files owned by someone else, or with no metadata left: unlink the association only. */
  unlinkOnlyFiles: AgentResourceFileRef[];
};

export type AgentResourceDeletionDeps<TFile> = {
  /** Which of these ids another agent still references; a shared file is never destroyed. */
  getSharedResourceFileIds: (params: {
    file_ids: string[];
    excludeAgentObjectId: string;
    excludeToolResource: string;
  }) => Promise<string[]>;
  removeAgentResourceFiles: (params: {
    agent_id: string;
    files: AgentResourceFileRef[];
  }) => Promise<unknown>;
  /** The full delete pass, injected: storage, vectors, metadata, and the unlink of what it deleted. */
  deleteFiles: (files: TFile[]) => Promise<FileDeletionOutcome>;
};

export type AgentResourceDeletionResult = {
  /** `null` when nothing was destroyed, so the caller answers with the unlink message. */
  outcome: FileDeletionOutcome | null;
  unlinkedFileIds: string[];
  destroyedFileIds: string[];
};

export const PARTIAL_FILE_DELETION_MESSAGE = 'Some files could not be deleted';

/**
 * Shapes the body of a delete response. A record whose storage delete failed is not an error for
 * the request as a whole, so the outcome travels in the body rather than the status: clients read
 * `failedFileIds` to know what is still on disk, and treat everything else they asked for as gone.
 */
export const buildDeleteFilesResponse = (
  result: FileDeletionOutcome | null | undefined,
  successMessage: string,
): DeleteFilesResponse => {
  const deletedFileIds = result?.deletedFileIds ?? [];
  const failedFileIds = result?.failedFileIds ?? [];
  return {
    message: failedFileIds.length > 0 ? PARTIAL_FILE_DELETION_MESSAGE : successMessage,
    deletedFileIds,
    failedFileIds,
  };
};

/**
 * Splits the files a delete request names for one agent tool resource into the ones whose storage
 * and embeddings may go with the unlink, and the ones only the association can be removed for.
 *
 * A file the caller owns is theirs to destroy, so it becomes a candidate for the full delete pass;
 * a file that belongs to another user, or that no longer has a metadata record, keeps its bytes and
 * its chunks and loses only its link to the agent. A file the request names but the tool resource
 * does not hold appears in neither list.
 */
export const partitionAgentResourceFiles = <TFile>({
  requestedFileIds,
  attachedFileIds,
  files,
  toolResource,
  userId,
}: {
  requestedFileIds: string[];
  attachedFileIds: string[];
  files: Array<AgentResourceFileInput<TFile>>;
  toolResource: string;
  userId: string;
}): AgentResourceDeletion<TFile> => {
  const attached = new Set(attachedFileIds);
  const inputsById = new Map(files.map((input) => [input.file_id, input]));
  const seen = new Set<string>();
  const ownedFiles: Array<AgentResourceFileInput<TFile>> = [];
  const unlinkOnlyFiles: AgentResourceFileRef[] = [];

  for (const fileId of requestedFileIds) {
    if (!attached.has(fileId) || seen.has(fileId)) {
      continue;
    }
    seen.add(fileId);
    const input = inputsById.get(fileId);
    if (input != null && input.owner === userId) {
      ownedFiles.push(input);
      continue;
    }
    unlinkOnlyFiles.push({ tool_resource: toolResource, file_id: fileId });
  }

  return { ownedFiles, unlinkOnlyFiles };
};

/**
 * Removes files from one agent tool resource, destroying only what this agent was the last holder
 * of.
 *
 * Three outcomes, decided per file. A file the caller does not own is unlinked and left whole. A
 * file the caller owns that any other `(agent, tool_resource)` pair still references is unlinked here
 * and left whole too:
 * duplicating an agent copies `file_ids` rather than the files behind them, so destroying the bytes
 * would empty the other agent's knowledge without touching its configuration. Only a file the
 * caller owns and this agent was the last to reference goes through the delete pass, which removes
 * the storage, the vector chunks and the metadata, and unlinks exactly what it managed to delete.
 */
export const deleteAgentResourceFiles = async <TFile>(
  {
    agentId,
    agentObjectId,
    toolResource,
    requestedFileIds,
    attachedFileIds,
    files,
    userId,
  }: {
    agentId: string;
    /** The agent's globally unique `_id`; `id` alone repeats across tenants. */
    agentObjectId: string;
    toolResource: string;
    requestedFileIds: string[];
    attachedFileIds: string[];
    files: Array<AgentResourceFileInput<TFile>>;
    userId: string;
  },
  deps: AgentResourceDeletionDeps<TFile>,
): Promise<AgentResourceDeletionResult> => {
  const { ownedFiles, unlinkOnlyFiles } = partitionAgentResourceFiles({
    requestedFileIds,
    attachedFileIds,
    files,
    toolResource,
    userId,
  });

  const sharedFileIds =
    ownedFiles.length === 0
      ? new Set<string>()
      : new Set(
          await deps.getSharedResourceFileIds({
            file_ids: ownedFiles.map((input) => input.file_id),
            excludeAgentObjectId: agentObjectId,
            excludeToolResource: toolResource,
          }),
        );

  const destroyable: Array<AgentResourceFileInput<TFile>> = [];
  const unlinkOnly = [...unlinkOnlyFiles];
  for (const input of ownedFiles) {
    if (sharedFileIds.has(input.file_id)) {
      unlinkOnly.push({ tool_resource: toolResource, file_id: input.file_id });
      continue;
    }
    destroyable.push(input);
  }

  /* The destroy runs before any reference is removed, and the delete pass strips the references of
     the files it actually deleted. A reference removed ahead of a destroy that then fails is what
     strands a file: it leaves the agent panel while its storage, chunks or metadata remain, and
     neither this route nor the client's retry queue can name it again. */
  const outcome =
    destroyable.length === 0
      ? null
      : await deps.deleteFiles(destroyable.map((input) => input.file));

  if (unlinkOnly.length > 0) {
    await deps.removeAgentResourceFiles({ agent_id: agentId, files: unlinkOnly });
  }

  return {
    outcome,
    unlinkedFileIds: unlinkOnly.map((ref) => ref.file_id),
    destroyedFileIds: outcome?.deletedFileIds ?? [],
  };
};
