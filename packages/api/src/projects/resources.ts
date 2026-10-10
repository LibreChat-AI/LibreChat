import { createHash } from 'crypto';
import { FileContext } from 'librechat-data-provider';
import type { TChatProject, TChatProjectFile, TFile } from 'librechat-data-provider';
import type { IChatProject, ProjectFileRecord } from '@librechat/data-schemas';
export type { ProjectFileRecord } from '@librechat/data-schemas';

export type CanonicalProjectResource = {
  file_id: string;
  identity: string;
  version: string;
} & ({ availability: 'ready'; file: TFile } | { availability: 'unavailable' });

/** Canonical lookup; metadata snapshots omit bodies, while active policy selects full records. */
export type GetProjectFiles = (options: {
  fileIds: string[];
  userId: string;
  tenantId?: string | null;
  includeContent?: boolean;
}) => Promise<ReadonlyArray<ProjectFileRecord> | null>;

/** Project resources are restricted to owner-scoped, unscoped message attachments. */
export function getChatProjectFileAvailability(
  file:
    | {
        embedded?: boolean;
        context?: string;
        expiredAt?: Date | number | string | null;
      }
    | null
    | undefined,
): 'ready' | 'unavailable' {
  if (!file || file.embedded !== true || file.context !== FileContext.message_attachment) {
    return 'unavailable';
  }

  if (file.expiredAt != null) {
    const expiry =
      file.expiredAt instanceof Date ? file.expiredAt.getTime() : Number(file.expiredAt);
    if (!Number.isFinite(expiry) || expiry <= Date.now()) {
      return 'unavailable';
    }
  }

  return 'ready';
}

async function loadProjectFiles({
  project,
  userId,
  tenantId,
  getProjectFiles,
  includeContent = false,
}: {
  project: Pick<IChatProject, 'file_ids'> | Pick<TChatProject, 'file_ids'>;
  userId: string;
  tenantId?: string;
  getProjectFiles: GetProjectFiles;
  includeContent?: boolean;
}): Promise<{ fileIds: string[]; byId: Map<string, ProjectFileRecord> }> {
  const fileIds = [
    ...new Set(
      (project.file_ids ?? []).filter((fileId): fileId is string => typeof fileId === 'string'),
    ),
  ];
  if (fileIds.length === 0) {
    return { fileIds, byId: new Map() };
  }
  const files = await getProjectFiles({
    fileIds,
    userId,
    tenantId,
    includeContent,
  });
  return { fileIds, byId: new Map((files ?? []).map((file) => [file.file_id, file])) };
}

function canonicalResourceVersion(
  file: ProjectFileRecord,
  identity: string,
  availability: 'ready' | 'unavailable',
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        identity,
        file_id: file.file_id,
        availability,
        embedded: file.embedded ?? null,
        context: file.context ?? null,
        expiredAt: file.expiredAt?.toISOString() ?? null,
        createdAt: file.createdAt?.toISOString() ?? null,
        updatedAt: file.updatedAt?.toISOString() ?? null,
        previewRevision: file.previewRevision ?? null,
        status: file.status ?? null,
        bytes: file.bytes,
        filename: file.filename,
        type: file.type,
      }),
    )
    .digest('hex');
}

export function toCanonicalProjectResource(file: ProjectFileRecord): CanonicalProjectResource {
  if (file._id == null) {
    throw new Error('Project file identity unavailable');
  }
  const identity = file._id.toString();
  const availability = getChatProjectFileAvailability(file);
  const version = canonicalResourceVersion(file, identity, availability);
  if (availability === 'ready') {
    return { file_id: file.file_id, identity, availability, version, file: toRuntimeFile(file) };
  }
  return { file_id: file.file_id, identity, availability, version };
}

export async function resolveChatProjectResources(params: {
  project: Pick<IChatProject, 'file_ids'> | Pick<TChatProject, 'file_ids'>;
  userId: string;
  tenantId?: string;
  getProjectFiles: GetProjectFiles;
}): Promise<CanonicalProjectResource[]> {
  const { fileIds, byId } = await loadProjectFiles(params);
  return fileIds.map((fileId) => {
    const file = byId.get(fileId);
    return file == null
      ? { file_id: fileId, identity: 'missing', availability: 'unavailable', version: 'missing' }
      : toCanonicalProjectResource(file);
  });
}

export async function resolveChatProjectPolicyFiles(params: {
  project: Pick<IChatProject, 'file_ids'> | Pick<TChatProject, 'file_ids'>;
  userId: string;
  tenantId?: string;
  getProjectFiles: GetProjectFiles;
}): Promise<ProjectFileRecord[]> {
  const { fileIds, byId } = await loadProjectFiles({ ...params, includeContent: true });
  return fileIds
    .map((fileId) => byId.get(fileId))
    .filter((file): file is ProjectFileRecord => getChatProjectFileAvailability(file) === 'ready');
}

type RuntimeFileSource = {
  file_id: string;
  filename: string;
  filepath: string;
  object: 'file';
  type: string;
  bytes: number;
  usage: number;
  user: string | { toString(): string };
  tenantId?: string;
};

export function toRuntimeFile(file: RuntimeFileSource): TFile {
  return {
    file_id: file.file_id,
    filename: file.filename,
    filepath: file.filepath,
    object: file.object,
    type: file.type,
    bytes: file.bytes,
    usage: file.usage,
    embedded: true,
    context: FileContext.message_attachment,
    user: typeof file.user === 'string' ? file.user : file.user.toString(),
    ...(file.tenantId != null ? { tenantId: file.tenantId } : {}),
  };
}

/**
 * Resolve resources for Agent runtime. Only currently eligible canonical files are returned,
 * deduplicated and with extracted text omitted. Callers must still intersect these files with
 * the selected Agent's already-enabled file-search capability.
 */
export async function resolveChatProjectFiles(params: {
  project: Pick<IChatProject, 'file_ids'> | Pick<TChatProject, 'file_ids'>;
  userId: string;
  tenantId?: string;
  getProjectFiles: GetProjectFiles;
  resources?: readonly CanonicalProjectResource[];
}): Promise<TFile[]> {
  const resources =
    params.resources ??
    (await resolveChatProjectResources({
      project: params.project,
      userId: params.userId,
      tenantId: params.tenantId,
      getProjectFiles: params.getProjectFiles,
    }));
  const files: TFile[] = [];
  for (const resource of resources) {
    if (resource.availability === 'ready') {
      files.push(resource.file);
    }
  }
  return files;
}

/**
 * Build the HTTP-safe project file view. Unlike runtime resolution, this retains an unavailable
 * placeholder for every stored ID so deleted, expired, or otherwise ineligible references are
 * visible without disclosing another owner's metadata.
 */
export async function listChatProjectFileViews(params: {
  project: Pick<IChatProject, 'file_ids'> | Pick<TChatProject, 'file_ids'>;
  userId: string;
  tenantId?: string;
  getProjectFiles: GetProjectFiles;
}): Promise<TChatProjectFile[]> {
  const { fileIds, byId } = await loadProjectFiles(params);
  return fileIds.map((file_id) => {
    const file = byId.get(file_id);
    return {
      file_id,
      ...(file
        ? {
            ...(typeof file.filename === 'string' ? { filename: file.filename } : {}),
            ...(typeof file.type === 'string' ? { type: file.type } : {}),
            ...(typeof file.bytes === 'number' ? { bytes: file.bytes } : {}),
          }
        : {}),
      availability: getChatProjectFileAvailability(file),
    };
  });
}
