import { logger } from '@librechat/data-schemas';
import {
  EModelEndpoint,
  EToolResources,
  AgentCapabilities,
  FileContext,
  FileSources,
  getCodeEnvRefs,
  canToolResourceConsume,
  hasToolResourceProvisioning,
} from 'librechat-data-provider';
import type {
  AgentToolResources,
  CodeEnvReferenceSet,
  AgentBaseResource,
  CodeEnvRef,
  TFile,
} from 'librechat-data-provider';
import type { IMongoFile, AppConfig, IUser } from '@librechat/data-schemas';
import type { FilterQuery, QueryOptions, ProjectionType } from 'mongoose';
import type { ServerRequest } from '~/types';

import { TOOL_RESOURCE_KEYS } from './orphans';

/** Removes runtime-only file records before persisted Agent resources enter tool initialization. */
const sanitizePersistedToolResources = (
  tool_resources: AgentToolResources | undefined,
): AgentToolResources => {
  const sanitized: AgentToolResources = {};
  for (const key of TOOL_RESOURCE_KEYS) {
    const resource = tool_resources?.[key];
    if (!resource) {
      continue;
    }
    const persistedResource = { ...resource };
    delete persistedResource.files;
    sanitized[key] = persistedResource;
  }
  return sanitized;
};

/** Deferred DB update from provisioning (batched after all files are provisioned) */
export type TFileUpdate = {
  file_id: string;
  metadata?: Record<string, unknown>;
  embedded?: boolean;
};

/**
 * Function type for provisioning a file to the code execution environment.
 * @returns The codeEnvRef and a deferred DB update object
 */
export type TProvisionToCodeEnv = (params: {
  req: ServerRequest;
  file: TFile;
  entity_id?: string;
}) => Promise<{ referenceSet: CodeEnvReferenceSet; fileUpdate: TFileUpdate }>;

/**
 * Function type for provisioning a file to the vector DB for file_search.
 * @returns Object with embedded status and a deferred DB update object
 */
export type TProvisionToVectorDB = (params: {
  req: ServerRequest;
  file: TFile;
  entity_id?: string;
  existingStream?: unknown;
}) => Promise<{ embedded: boolean; fileUpdate: TFileUpdate | null }>;

/**
 * Function type for batch-checking code env file liveness.
 * Groups files by session, makes one API call per session.
 * @returns Set of file_ids that are confirmed alive
 */
export type TCheckSessionsAlive = (params: {
  files: TFile[];
  req?: ServerRequest;
  apiKey?: string;
  staleSafeWindowMs?: number;
  baseURL?: string;
  routeKey?: string;
}) => Promise<Set<string>>;

/** Loads CODE_API_KEY for a user. Call once per request. */
export type TLoadCodeApiKey = (userId: string) => Promise<string>;

/** State computed during primeResources for lazy provisioning at tool invocation time */
export type ProvisionState = {
  /** Files that need uploading to the code execution environment */
  codeEnvFiles: TFile[];
  /** Names from cleared refs on this state's active route; never reusable storage pointers. */
  codeEnvRecoveryNames?: Map<string, { name: string; isTargetScope: boolean }>;
  /** Files that need embedding into the vector DB for file_search */
  vectorDBFiles: TFile[];
  /** Set of file_ids confirmed alive in code env (from staleness check) */
  aliveFileIds: Set<string>;
  /** The active agent's own resource files, which are the only ones provisioned under its
   *  shared identity. A record carrying an agent context is not enough: a user may attach
   *  another agent's setup file to this conversation, and provisioning it here would put
   *  it in a namespace this agent's other users can read. */
  agentScopedFileIds: Set<string>;
};

/**
 * Function type for retrieving files from the database
 * @param filter - MongoDB filter query for files
 * @param _sortOptions - Sorting options (currently unused)
 * @param selectFields - Field selection options
 * @returns Promise resolving to array of files
 */
export type TGetFiles = (
  filter: FilterQuery<IMongoFile>,
  _sortOptions: ProjectionType<IMongoFile> | null | undefined,
  selectFields: QueryOptions<IMongoFile> | null | undefined,
) => Promise<Array<TFile>>;

/**
 * Function type for filtering files by agent access permissions.
 * Used to enforce that only files the user has access to (via ownership or agent attachment)
 * are returned after a raw DB query.
 */
export type TFilterFilesByAgentAccess = (params: {
  files: Array<TFile>;
  userId: string;
  role?: string;
  agentId: string;
}) => Promise<Array<TFile>>;

/**
 * Helper function to add a file to a specific tool resource category
 * Prevents duplicate files within the same resource category
 * @param params - Parameters object
 * @param params.file - The file to add to the resource
 * @param params.resourceType - The type of tool resource (e.g., execute_code, file_search, image_edit)
 * @param params.tool_resources - The agent's tool resources object to update
 * @param params.processedResourceFiles - Set tracking processed files per resource type
 */
export const addFileToResource = ({
  file,
  resourceType,
  tool_resources,
  processedResourceFiles,
}: {
  file: TFile;
  resourceType: EToolResources;
  tool_resources: AgentToolResources;
  processedResourceFiles: Set<string>;
}): void => {
  if (!file.file_id) {
    return;
  }

  const resourceKey = `${resourceType}:${file.file_id}`;
  if (processedResourceFiles.has(resourceKey)) {
    return;
  }

  const resource = tool_resources[resourceType as keyof AgentToolResources] ?? {};
  if (!resource.files) {
    (tool_resources[resourceType as keyof AgentToolResources] as AgentBaseResource) = {
      ...resource,
      files: [],
    };
  }

  // Check if already exists in the files array
  const resourceFiles = tool_resources[resourceType as keyof AgentToolResources]?.files;
  const alreadyExists = resourceFiles?.some((f: TFile) => f.file_id === file.file_id);

  if (!alreadyExists) {
    resourceFiles?.push(file);
    processedResourceFiles.add(resourceKey);
  }
};

/** Contexts that positively identify an agent's own setup files. Everything else,
 *  including generated images, code outputs, and unknown contexts, belongs to the
 *  requesting user: provisioning those under a shared agent would copy one user's
 *  private file into a sandbox every other user of that agent can read. An allowlist
 *  fails safe, since an unrecognized context provisions per user rather than leaking. */

/** Whether a file's existing vectors live under the agent's identity rather than the
 *  user's. This reads where content already is, which the record's context records.
 *  Where new provisioning may write is a separate question, answered by membership in
 *  the active agent's resources. */
const AGENT_SCOPED_FILE_CONTEXTS = new Set<string>([FileContext.agents]);

export const isAgentScopedFile = (file: Pick<TFile, 'context'>): boolean =>
  AGENT_SCOPED_FILE_CONTEXTS.has(file.context as string);

/**
 * Whether this file's vectors exist in the namespace about to be queried, named by the
 * agent whose namespace it is or by the user for the unscoped one.
 *
 * The record-wide `embedded` flag only says the file was embedded somewhere. An agent's
 * setup file attached to a second agent is embedded under the first agent's entity, so
 * trusting the flag registers it for a namespace that holds none of its vectors and the
 * search returns nothing. Records embedded before namespaces were tracked carry no entity
 * list and are re-embedded once per namespace, which repairs the record as it goes.
 */
const isEmbeddedForNamespace = (file: TFile, namespaceId?: string): boolean => {
  if (!isAgentScopedFile(file)) {
    return file.embedded === true;
  }
  return namespaceId != null && file.metadata?.embeddedEntities?.includes(namespaceId) === true;
};

/** The scope a code upload would be filed under this turn, mirroring what
 *  provisionToCodeEnv records: an agent's own resource file belongs to the agent, and
 *  everything else to the requesting user. */
interface CodeEnvScope {
  kind: 'agent' | 'user';
  id?: string;
}

/**
 * Whether this file already has a sandbox reference for the route the agent will execute
 * on, under the identity this turn would use. A reference for another deployment does not
 * make the file reachable here, and neither does one owned by another agent or user:
 * `kind` and `id` are what Code API derives its session key from, so reusing a foreign
 * reference points the tool at a session this caller cannot read. References this
 * pipeline does not write, skill files being the case in point, are left to their owner.
 */
const hasCodeRefForRoute = (file: TFile, routeKey: string, scope: CodeEnvScope): boolean =>
  getCodeEnvRefs(file.metadata).some(
    ([key, ref]) =>
      key === routeKey &&
      (ref.kind !== 'agent' && ref.kind !== 'user'
        ? true
        : ref.kind === scope.kind && ref.id === scope.id),
  );

/** Mirrors the lazy provisioning writer: agent-scoped search files live in
 *  `file_ids`, which is the only shape fileSearch treats as agent-owned. */
const addAgentScopedSearchFile = ({
  file,
  tool_resources,
  processedResourceFiles,
}: {
  file: TFile;
  tool_resources: AgentToolResources;
  processedResourceFiles: Set<string>;
}): void => {
  if (!file.file_id) {
    return;
  }
  const resourceKey = `${EToolResources.file_search}:${file.file_id}`;
  if (processedResourceFiles.has(resourceKey)) {
    return;
  }
  const resource = tool_resources[EToolResources.file_search] ?? {};
  const fileIds = resource.file_ids ? [...resource.file_ids] : [];
  if (!fileIds.includes(file.file_id)) {
    fileIds.push(file.file_id);
  }
  tool_resources[EToolResources.file_search] = { ...resource, file_ids: fileIds };
  processedResourceFiles.add(resourceKey);
};

/**
 * Categorizes a file into the appropriate tool resource based on its properties
 * Files are categorized as:
 * - execute_code: Files with a code-environment ref (`codeEnvRef`)
 * - file_search: Files marked as embedded
 * - image_edit: Image files in the request file set with dimensions
 * @param params - Parameters object
 * @param params.file - The file to categorize
 * @param params.tool_resources - The agent's tool resources to update
 * @param params.requestFileSet - Set of file IDs from the current request
 * @param params.processedResourceFiles - Set tracking processed files per resource type
 */
const categorizeFileForToolResources = ({
  file,
  tool_resources,
  requestFileSet,
  processedResourceFiles,
  agentScoped = false,
  agentId,
  userId,
}: {
  file: TFile;
  tool_resources: AgentToolResources;
  requestFileSet: Set<string>;
  processedResourceFiles: Set<string>;
  /** Whether this file's vectors were embedded under the agent's entity_id. */
  agentScoped?: boolean;
  /** The agent whose vector namespace this turn will search, when one is scoped. */
  agentId?: string;
  /** Owner of the unscoped namespace, which is where anything not agent-scoped lands. */
  userId?: string;
}): void => {
  if (file.metadata?.codeEnvRef || file.metadata?.codeEnvRefs) {
    addFileToResource({
      file,
      resourceType: EToolResources.execute_code,
      tool_resources,
      processedResourceFiles,
    });
  }

  /* Judged per namespace, not by the record-wide flag: registering a file this agent's
   * namespace never received would make search query for vectors that are not there. */
  if (isEmbeddedForNamespace(file, agentScoped ? agentId : userId)) {
    /** Agent-scoped files are embedded under `entity_id: agentId`, so they must be
     *  reconstructed as `file_ids`: fileSearch's primeFiles only marks those
     *  `fromAgent` and only `fromAgent` queries carry the entity_id that can find
     *  their vectors. Rebuilding them under `.files` makes them unsearchable. */
    if (agentScoped) {
      addAgentScopedSearchFile({ file, tool_resources, processedResourceFiles });
    } else {
      addFileToResource({
        file,
        resourceType: EToolResources.file_search,
        tool_resources,
        processedResourceFiles,
      });
    }
  }

  if (
    requestFileSet.has(file.file_id) &&
    file.type.startsWith('image') &&
    file.height &&
    file.width
  ) {
    addFileToResource({
      file,
      resourceType: EToolResources.image_edit,
      tool_resources,
      processedResourceFiles,
    });
  }
};

/**
 * Primes resources for agent execution by processing attachments and tool resources
 * This function:
 * 1. Fetches context/OCR files (filtered by agent access control when available)
 * 2. Processes attachment files
 * 3. Categorizes files into appropriate tool resources
 * 4. Prevents duplicate files across all sources
 *
 * @param params - Parameters object
 * @param params.req - Express request object
 * @param params.appConfig - Application configuration object
 * @param params.getFiles - Function to retrieve files from database
 * @param params.filterFiles - Optional function to enforce agent-based file access control
 * @param params.requestFileSet - Set of file IDs from the current request
 * @param params.attachments - Promise resolving to array of attachment files
 * @param params.tool_resources - Existing tool resources for the agent
 * @param params.agentId - Agent ID used for access control filtering
 * @returns Promise resolving to processed attachments and updated tool resources
 */
/** Code env pointers are deployment-local, so a ref is probed against the Code API that
 *  issued it. The probe therefore runs on the route this turn executes on, and only refs
 *  belonging to that route take part or may be cleared as stale. */
const codeEnvRouteKey = (ref: CodeEnvRef): string =>
  ref.executionRouteKey ?? ref.executionProfile ?? 'default';

/** The reference a given route issued, across both the per-route map and the legacy
 *  single pointer. */
const codeEnvRefForRoute = (file: TFile, routeKey: string): CodeEnvRef | undefined =>
  getCodeEnvRefs(file.metadata).find(([key]) => key === routeKey)?.[1];

/** Attachments plus any deferred candidates not already present, deduped by file_id.
 *  Only the provisioning computation sees this: the delivery list stays untouched. */
const withDeferredCandidates = (
  attachments: Array<TFile>,
  candidates?: Array<TFile>,
): Array<TFile> => {
  if (!candidates || candidates.length === 0) {
    return attachments;
  }
  const seen = new Set(attachments.map((file) => file.file_id));
  const merged = [...attachments];
  for (const candidate of candidates) {
    if (candidate?.file_id && !seen.has(candidate.file_id)) {
      seen.add(candidate.file_id);
      merged.push(candidate);
    }
  }
  return merged;
};

/**
 * Lazy provisioning: instead of provisioning files now, compute which files need
 * provisioning. Actual provisioning happens at tool invocation time via the
 * ON_TOOL_EXECUTE handler. Runs for persistent agent context files too, so a turn
 * that carries no new attachment still queues them.
 */
const computeProvisionState = async ({
  req,
  attachments,
  resourcePrincipal,
  enabledToolResources,
  tool_resources,
  processedResourceFiles,
  checkSessionsAlive,
  loadCodeApiKey,
  agentId,
  codeRouteKey,
  codeBaseUrl,
  agentScopedFileIds,
  persistedResourceMembership,
  staleSafeWindowMs,
}: {
  req?: ServerRequest;
  attachments: Array<TFile>;
  agentId?: string;
  codeRouteKey?: string;
  /** Base URL of the deployment this turn runs on, used to probe its own refs. */
  codeBaseUrl?: string;
  agentScopedFileIds?: ReadonlySet<string>;
  resourcePrincipal?: Pick<IUser, 'id' | 'role'>;
  enabledToolResources?: Set<EToolResources>;
  tool_resources: AgentToolResources;
  processedResourceFiles: Set<string>;
  checkSessionsAlive?: TCheckSessionsAlive;
  loadCodeApiKey?: TLoadCodeApiKey;
  /** Which resource each persisted file is filed under, before categorization mutates it. */
  persistedResourceMembership?: ReadonlyMap<EToolResources, ReadonlySet<string>>;
  staleSafeWindowMs?: number;
}): Promise<ProvisionState | undefined> => {
  if (!enabledToolResources || enabledToolResources.size === 0 || attachments.length === 0) {
    return undefined;
  }

  /* The legacy chooser makes the destination an explicit user decision, so a file it
   * uploaded carries no reference for the destinations the user declined, and queueing on
   * a missing reference would read those declines as work to do. The decision belongs to
   * the file, not to this request: the endpoint deciding this turn need not be the one it
   * was uploaded under. Records predating the marker were written by the chooser flow,
   * so their existing resource membership/reference is the only durable destination evidence. */
  const cameFromChooser = (file: TFile): boolean => {
    const choice = file.metadata?.destinationChosen;
    return choice == null ? true : choice;
  };

  /** A chooser upload may still be provisioned for the destination it was filed under,
   *  which is how an inherited search file gets vectors in a duplicated agent's namespace.
   *  The destinations it carries no reference for were declined, not deferred. */
  /** What the record itself shows about where it was sent. A message attachment is never
   *  in the agent's resources, so a reference or an embedding is the only evidence that
   *  the chooser picked that destination, and it is proof: nothing else creates one. */
  /* The predicate the turn's delivery decision reads too, so a file this queue has yet to
   * provision is never one the prompt withheld its text for. */
  const carriesEvidenceFor = (file: TFile, resourceType: EToolResources): boolean =>
    hasToolResourceProvisioning(file, resourceType);

  const allowsResource = (file: TFile, resourceType: EToolResources): boolean => {
    if (!cameFromChooser(file)) {
      return true;
    }
    const isPersistedResource =
      file.file_id != null &&
      persistedResourceMembership?.get(resourceType)?.has(file.file_id) === true;
    return isPersistedResource || carriesEvidenceFor(file, resourceType);
  };
  const provisionable = attachments.filter(
    (file) =>
      file != null &&
      (allowsResource(file, EToolResources.execute_code) ||
        allowsResource(file, EToolResources.file_search)),
  );
  if (provisionable.length === 0) {
    return undefined;
  }

  const needsCodeEnv = enabledToolResources.has(EToolResources.execute_code);
  const needsVectorDB = enabledToolResources.has(EToolResources.file_search);
  if (!needsCodeEnv && !needsVectorDB) {
    return undefined;
  }

  const activeCodeRouteKey = codeRouteKey ?? 'default';

  /** Batch staleness check: identify which code env files are still alive. Only files
   *  that already carry a ref for this turn's route can be probed, so that set is
   *  computed first: a turn whose attachments are all freshly uploaded has nothing to
   *  probe and must not pay for a credential lookup that cannot change the outcome. */
  /* A non-default route can only be probed when its own base URL is known; the default
   *  Code API is resolved by the probe itself when none is passed. */
  const canProbeRoute = activeCodeRouteKey === 'default' || codeBaseUrl != null;
  const filesWithIdentifiers =
    needsCodeEnv && checkSessionsAlive && canProbeRoute
      ? provisionable.filter((f) => f?.file_id && codeEnvRefForRoute(f, activeCodeRouteKey))
      : [];

  /** Code API auth is optional: deployments may use a legacy key, JWT bearer minting,
   *  or no auth at all, and the upload path handles each. Credentials therefore gate
   *  only the liveness probe, never whether files are queued for provisioning. */
  let codeApiKey: string | undefined;
  if (filesWithIdentifiers.length > 0 && loadCodeApiKey && resourcePrincipal?.id) {
    try {
      codeApiKey = await loadCodeApiKey(resourcePrincipal.id);
    } catch (error) {
      logger.error('[primeResources] Failed to load CODE_API_KEY', error);
    }
  }

  /** Requires credentials the callback can actually send: a legacy key, or a req to
   *  mint JWT bearer auth from. Without either, skip the check so an unauthorized 401
   *  cannot mark live sandbox files as expired. */
  let aliveFileIds: Set<string> | undefined;
  if (filesWithIdentifiers.length > 0 && checkSessionsAlive && (codeApiKey != null || req)) {
    aliveFileIds = await checkSessionsAlive({
      files: filesWithIdentifiers as TFile[],
      req,
      apiKey: codeApiKey,
      baseURL: codeBaseUrl,
      routeKey: activeCodeRouteKey,
      staleSafeWindowMs,
    });
  }

  const scopedIds = agentScopedFileIds ?? new Set<string>();
  const codeEnvFiles: TFile[] = [];
  const codeEnvRecoveryNames: NonNullable<ProvisionState['codeEnvRecoveryNames']> = new Map();
  const vectorDBFiles: TFile[] = [];

  for (const file of provisionable) {
    if (!file?.file_id) {
      continue;
    }

    /* Mirrors entityIdForFile in the provisioning callback: membership in the agent's own
     * resources decides both the vector namespace and the sandbox identity, so the queue
     * asks about the scope the upload will actually write under. */
    const isAgentScoped = scopedIds.has(file.file_id);
    const namespaceId = isAgentScoped ? agentId : resourcePrincipal?.id;
    const codeScope: CodeEnvScope = isAgentScoped
      ? { kind: 'agent', id: agentId }
      : { kind: 'user', id: resourcePrincipal?.id };

    /** Text-source records keep their content in the database with no backing object
     *  to stream, so provisioning them would fail and, for code, abort the turn.
     *  Provisioning them from their stored text is tracked as follow-up work. */
    if (file.source === FileSources.text) {
      continue;
    }

    /* Same question the search branch asks, and the same consequence: uploading a type
     * the sandbox refuses aborts the tool batch over a file meant for the model. */
    if (
      needsCodeEnv &&
      allowsResource(file, EToolResources.execute_code) &&
      canToolResourceConsume(EToolResources.execute_code, file.type ?? '')
    ) {
      const legacyRef = file.metadata?.codeEnvRef;
      const routeRef = codeEnvRefForRoute(file, activeCodeRouteKey);
      /* Liveness answers only for the route it was probed on, so a ref belonging to
       * another deployment is never cleared on the strength of this turn's answer. */
      const isStale = routeRef != null && aliveFileIds != null && !aliveFileIds.has(file.file_id);

      /** Staleness must be repaired even for files that pre-categorization already
       *  added to execute_code resources, so the check runs before the processed
       *  guard. Clear both the legacy ref and its route entry, else getCodeEnvRefs
       *  keeps resolving the dead session over the re-provisioned one. */
      if (isStale) {
        if (routeRef?.sandboxFilename) {
          codeEnvRecoveryNames.set(file.file_id, {
            name: routeRef.sandboxFilename,
            isTargetScope: hasCodeRefForRoute(file, activeCodeRouteKey, codeScope),
          });
        }
        logger.info(
          `[primeResources] Code env file expired for "${file.filename}" (${file.file_id}), will re-provision on tool use`,
        );
        const remainingRefs = Object.fromEntries(
          Object.entries(file.metadata?.codeEnvRefs ?? {}).filter(
            ([routeKey]) => routeKey !== activeCodeRouteKey,
          ),
        );
        /* The legacy pointer only answers for the route it names, so a ref for another
         * deployment survives a stale answer this turn could not have been about. */
        const legacyBelongsToRoute =
          legacyRef != null && codeEnvRouteKey(legacyRef) === activeCodeRouteKey;
        file.metadata = {
          ...file.metadata,
          codeEnvRef: legacyBelongsToRoute ? undefined : legacyRef,
          codeEnvRefs: Object.keys(remainingRefs).length > 0 ? remainingRefs : undefined,
        };
        codeEnvFiles.push(file);
      } else if (!hasCodeRefForRoute(file, activeCodeRouteKey, codeScope)) {
        /* Judged by the active route rather than by any reference at all: a file
         * provisioned to another deployment is not reachable from this one, and priming
         * resolves only this route, so it would be omitted from the sandbox call. The
         * pre-categorization pass marks such a file processed on the strength of the
         * reference it does have, so the processed flag cannot gate this. */
        codeEnvFiles.push(file);
      } else if (!processedResourceFiles.has(`${EToolResources.execute_code}:${file.file_id}`)) {
        addFileToResource({
          file,
          resourceType: EToolResources.execute_code,
          tool_resources,
          processedResourceFiles,
        });
      }
    }

    /* The same predicate the upload path files a consumer with. Queueing a type the
     * vector store cannot read sends it to RAG on the next search call and aborts the
     * tool when extraction refuses it. */
    if (
      needsVectorDB &&
      allowsResource(file, EToolResources.file_search) &&
      canToolResourceConsume(EToolResources.file_search, file.type ?? '') &&
      !isEmbeddedForNamespace(file, namespaceId) &&
      !processedResourceFiles.has(`${EToolResources.file_search}:${file.file_id}`)
    ) {
      vectorDBFiles.push(file);
    }
  }

  if (codeEnvFiles.length === 0 && vectorDBFiles.length === 0) {
    return undefined;
  }
  return {
    codeEnvFiles,
    codeEnvRecoveryNames,
    vectorDBFiles,
    aliveFileIds: aliveFileIds ?? new Set(),
    agentScopedFileIds: new Set(scopedIds),
  };
};

export const primeResources = async ({
  req,
  principal,
  appConfig,
  getFiles,
  filterFiles,
  requestFileSet,
  attachments: _attachments,
  tool_resources: _tool_resources,
  agentId,
  enabledToolResources,
  checkSessionsAlive,
  loadCodeApiKey,
  provisionCandidates,
  screenPersistentFiles,
  codeRouteKey,
  codeBaseUrl,
}: {
  req?: ServerRequest;
  principal?: Pick<IUser, 'id' | 'role'>;
  appConfig?: AppConfig;
  requestFileSet: Set<string>;
  attachments: Promise<Array<TFile | null>> | undefined;
  tool_resources: AgentToolResources | undefined;
  getFiles: TGetFiles;
  filterFiles?: TFilterFilesByAgentAccess;
  agentId?: string;
  /** Set of tool resource types the agent has enabled (e.g., execute_code, file_search) */
  enabledToolResources?: Set<EToolResources>;
  /** Optional callback to batch-check code env file liveness by session */
  checkSessionsAlive?: TCheckSessionsAlive;
  /** Optional callback to load CODE_API_KEY once per request */
  loadCodeApiKey?: TLoadCodeApiKey;
  /** Attachments from earlier turns that were never provisioned. Considered for
   *  provisioning only and never returned as attachments: re-delivering an earlier
   *  upload to the model on every later turn is not the intent. */
  provisionCandidates?: Array<TFile>;
  /** True when this endpoint still shows the explicit upload-destination chooser. */
  /** Applies the caller's endpoint and content policies. Persistent agent files are read
   *  here rather than by the caller, so the caller has no chance to screen them itself
   *  and a configuration or policy change since they were attached would otherwise let
   *  their bytes reach the model, the Code API or RAG. */
  screenPersistentFiles?: (files: Array<TFile>) => Array<TFile>;
  /** The code deployment this turn will execute on, which decides whether an existing
   *  sandbox reference is usable here. */
  codeRouteKey?: string;
  /** Base URL of that deployment. Refs are deployment-local, so the liveness probe runs
   *  against the Code API that issued them rather than the default one. */
  codeBaseUrl?: string;
}): Promise<{
  attachments: Array<TFile | undefined> | undefined;
  requestAttachments: Array<TFile | undefined> | undefined;
  agentContextAttachments: Array<TFile | undefined> | undefined;
  tool_resources: AgentToolResources | undefined;
  provisionState?: ProvisionState;
  warnings: string[];
}> => {
  const resourcePrincipal = principal ?? req?.user;
  const requestAttachments: Array<TFile> = [];
  const agentContextAttachments: Array<TFile> = [];
  const persistedToolResources = sanitizePersistedToolResources(_tool_resources);
  let safeToolResources = persistedToolResources;
  try {
    /**
     * Array to collect all unique files that will be returned as attachments
     * Files are added from OCR results and attachment promises, with duplicates prevented
     */
    const attachments: Array<TFile> = [];
    const warnings: string[] = [];
    /**
     * Set of file IDs already added to the attachments array
     * Used to prevent duplicate files from being added multiple times
     * Pre-populated with files from non-OCR tool_resources to prevent re-adding them
     */
    const attachmentFileIds = new Set<string>();
    /**
     * Set tracking which files have been added to specific tool resource categories
     * Format: "resourceType:fileId" (e.g., "execute_code:file123")
     * Prevents the same file from being added multiple times to the same resource
     */
    const processedResourceFiles = new Set<string>();
    /**
     * The agent's tool resources object that will be updated with categorized files
     * Create a shallow copy first to avoid mutating the original
     */
    const tool_resources: AgentToolResources = { ...persistedToolResources };
    safeToolResources = tool_resources;

    // Deep copy each resource to avoid mutating nested objects/arrays
    for (const [resourceType, resource] of Object.entries(tool_resources)) {
      if (!resource) {
        continue;
      }

      // Deep copy the resource to avoid mutations
      tool_resources[resourceType as keyof AgentToolResources] = {
        ...resource,
        // Deep copy arrays to prevent mutations
        ...(resource.files && { files: [...resource.files] }),
        ...(resource.file_ids && { file_ids: [...resource.file_ids] }),
        ...(resource.vector_store_ids && { vector_store_ids: [...resource.vector_store_ids] }),
      } as AgentBaseResource;

      // Now track existing files
      if (resource.files && Array.isArray(resource.files)) {
        for (const file of resource.files) {
          if (file?.file_id) {
            processedResourceFiles.add(`${resourceType}:${file.file_id}`);
            // Files from non-context resources should not be added to attachments from _attachments
            if (resourceType !== EToolResources.context && resourceType !== EToolResources.ocr) {
              attachmentFileIds.add(file.file_id);
            }
          }
        }
      }
    }

    const isContextEnabled = (
      appConfig?.endpoints?.[EModelEndpoint.agents]?.capabilities ?? []
    ).includes(AgentCapabilities.context);

    const fileIds = tool_resources[EToolResources.context]?.file_ids ?? [];
    const ocrFileIds = tool_resources[EToolResources.ocr]?.file_ids;
    if (ocrFileIds != null) {
      fileIds.push(...ocrFileIds);
      delete tool_resources[EToolResources.ocr];
    }

    const shouldLoadContext = fileIds.length > 0 && isContextEnabled;
    const contextFileIds = new Set(shouldLoadContext ? fileIds : []);
    const imageEditFileIds = tool_resources[EToolResources.image_edit]?.file_ids ?? [];
    const imageEditFileIdSet = new Set(imageEditFileIds);
    const persistedResourceFileIds = new Set(contextFileIds);
    for (const fileId of imageEditFileIds) {
      persistedResourceFileIds.add(fileId);
    }

    /** The agent's own tool resource files are provisioning candidates in their own right.
     *  A promoted code upload waits for the route the turn resolves, and an inherited
     *  search file may hold no vectors in this agent's namespace, so both have to be
     *  loaded even on a turn that attaches nothing. They are candidates only: delivery
     *  still follows the context ids below. */
    const toolResourceFileIds = new Set<string>();
    /** Which resource each persisted file is filed under, read before categorization
     *  mutates tool_resources. A legacy upload's selected destination is the only one it
     *  may be provisioned for; the rest were declined. */
    const persistedResourceMembership = new Map<EToolResources, Set<string>>();
    const provisionableResources = [
      {
        type: EToolResources.execute_code,
        ids: tool_resources[EToolResources.execute_code]?.file_ids,
      },
      {
        type: EToolResources.file_search,
        ids: tool_resources[EToolResources.file_search]?.file_ids,
      },
    ];
    for (const { type, ids } of provisionableResources) {
      persistedResourceMembership.set(type, new Set(ids ?? []));
      if (enabledToolResources?.has(type) !== true) {
        continue;
      }
      for (const fileId of ids ?? []) {
        toolResourceFileIds.add(fileId);
        persistedResourceFileIds.add(fileId);
      }
    }
    const resourceProvisionCandidates: Array<TFile> = [];

    if (shouldLoadContext) {
      delete tool_resources[EToolResources.context];
    }

    let persistedResourceFiles: Array<TFile> = [];
    if (persistedResourceFileIds.size > 0) {
      persistedResourceFiles = await getFiles(
        {
          file_id: { $in: Array.from(persistedResourceFileIds) },
        },
        {},
        {},
      );

      if (filterFiles && resourcePrincipal?.id && agentId) {
        persistedResourceFiles = await filterFiles({
          files: persistedResourceFiles,
          userId: resourcePrincipal.id,
          role: resourcePrincipal.role,
          agentId,
        });
      }

      if (screenPersistentFiles) {
        const admitted = screenPersistentFiles(persistedResourceFiles);
        /* The tool primers read tool_resources ids directly and re-check only access, so
         * a record dropped here still reaches the Code API or RAG unless its id goes with
         * it. Screening the hydrated list alone screens nothing. */
        if (admitted.length !== persistedResourceFiles.length) {
          const admittedIds = new Set(
            admitted.map((file) => file.file_id).filter((id): id is string => id != null),
          );
          const rejectedIds = persistedResourceFiles
            .map((file) => file.file_id)
            .filter((id): id is string => id != null && !admittedIds.has(id));
          const runtimeResources = [
            tool_resources[EToolResources.execute_code],
            tool_resources[EToolResources.file_search],
          ];
          for (const resource of runtimeResources) {
            if (resource?.file_ids == null) {
              continue;
            }
            resource.file_ids = resource.file_ids.filter((id: string) => !rejectedIds.includes(id));
          }
          for (const id of rejectedIds) {
            toolResourceFileIds.delete(id);
          }
        }
        persistedResourceFiles = admitted;
      }
    }

    for (const file of persistedResourceFiles) {
      if (!file?.file_id) {
        continue;
      }

      if (contextFileIds.has(file.file_id)) {
        attachmentFileIds.delete(file.file_id);

        categorizeFileForToolResources({
          file,
          tool_resources,
          requestFileSet,
          processedResourceFiles,
          agentScoped: agentId != null && isAgentScopedFile(file),
          agentId,
          userId: resourcePrincipal?.id,
        });

        attachments.push(file);
        agentContextAttachments.push(file);
        attachmentFileIds.add(file.file_id);
      }

      if (toolResourceFileIds.has(file.file_id)) {
        resourceProvisionCandidates.push(file);
      }

      if (imageEditFileIdSet.has(file.file_id)) {
        addFileToResource({
          file,
          resourceType: EToolResources.image_edit,
          tool_resources,
          processedResourceFiles,
        });
        attachmentFileIds.add(file.file_id);
      }
    }

    if (!_attachments) {
      /** Persistent agent context files are already collected above; queue them for
       *  provisioning here too, so a turn with no new attachment still primes them. */
      const contextProvisionState = await computeProvisionState({
        req,
        attachments: withDeferredCandidates(attachments, [
          ...(provisionCandidates ?? []),
          ...resourceProvisionCandidates,
        ]),
        resourcePrincipal,
        enabledToolResources,
        tool_resources,
        processedResourceFiles,
        checkSessionsAlive,
        loadCodeApiKey,
        agentId,
        codeRouteKey,
        codeBaseUrl,
        agentScopedFileIds: persistedResourceFileIds,
        persistedResourceMembership,
        staleSafeWindowMs: appConfig?.fileConfig?.codeEnvLivenessSafeWindowMs,
      });
      return {
        attachments: attachments.length > 0 ? attachments : undefined,
        requestAttachments: undefined,
        agentContextAttachments:
          agentContextAttachments.length > 0 ? agentContextAttachments : undefined,
        tool_resources,
        provisionState: contextProvisionState,
        warnings,
      };
    }

    const files = await _attachments;
    const requestAttachmentFileIds = new Set<string>();

    for (const file of files) {
      if (!file) {
        continue;
      }

      categorizeFileForToolResources({
        file,
        tool_resources,
        requestFileSet,
        processedResourceFiles,
        userId: resourcePrincipal?.id,
      });

      if (file.file_id && attachmentFileIds.has(file.file_id)) {
        if (!requestAttachmentFileIds.has(file.file_id)) {
          requestAttachments.push(file);
          requestAttachmentFileIds.add(file.file_id);
        }
        continue;
      }

      attachments.push(file);
      if (!file.file_id || !requestAttachmentFileIds.has(file.file_id)) {
        requestAttachments.push(file);
      }
      if (file.file_id) {
        attachmentFileIds.add(file.file_id);
        requestAttachmentFileIds.add(file.file_id);
      }
    }

    const provisionState = await computeProvisionState({
      req,
      attachments: withDeferredCandidates(attachments, [
        ...(provisionCandidates ?? []),
        ...resourceProvisionCandidates,
      ]),
      resourcePrincipal,
      enabledToolResources,
      tool_resources,
      processedResourceFiles,
      checkSessionsAlive,
      loadCodeApiKey,
      agentId,
      codeRouteKey,
      codeBaseUrl,
      agentScopedFileIds: persistedResourceFileIds,
      persistedResourceMembership,
      staleSafeWindowMs: appConfig?.fileConfig?.codeEnvLivenessSafeWindowMs,
    });

    return {
      attachments: attachments.length > 0 ? attachments : [],
      requestAttachments,
      agentContextAttachments:
        agentContextAttachments.length > 0 ? agentContextAttachments : undefined,
      tool_resources,
      provisionState,
      warnings,
    };
  } catch (error) {
    logger.error('Error priming resources', error);

    // Safely try to get attachments without rethrowing
    let safeAttachments: Array<TFile | undefined> = [];
    if (_attachments) {
      try {
        const attachmentFiles = await _attachments;
        safeAttachments = (attachmentFiles?.filter((file) => !!file) ?? []) as Array<TFile>;
      } catch (attachmentError) {
        // If attachments promise is also rejected, just use empty array
        logger.error('Error resolving attachments in catch block', attachmentError);
        safeAttachments = [];
      }
    }

    return {
      attachments: safeAttachments,
      requestAttachments: safeAttachments,
      agentContextAttachments:
        agentContextAttachments.length > 0 ? agentContextAttachments : undefined,
      tool_resources: safeToolResources,
      provisionState: undefined,
      warnings: [],
    };
  }
};
