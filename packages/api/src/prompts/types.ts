import type {
  FiltersConfig,
  PrincipalType,
  TCreatePromptRecord,
  TDeletePromptResponse,
  TMakePromptProductionResponse,
} from 'librechat-data-provider';
import type { PromptGroupSource } from '@librechat/data-schemas';
import type { StoredBaseConfig } from '../langfuse/promptSync';
import type { ProtectionFinding } from '../protection/types';

export type PromptKind = 'text' | 'chat';
export type PromptTimestamp = string | Date;

/** A stored ID as the database returns it: a string or an ObjectId-like value. */
export interface StoredId {
  toString(): string;
}

export interface PromptRecord {
  readonly _id: string;
  readonly groupId: string;
  readonly author: string;
  readonly prompt: string;
  /** Absent on some stored revisions, because the first revision skipped schema validation. */
  readonly type?: PromptKind;
  readonly createdAt?: PromptTimestamp;
  readonly updatedAt?: PromptTimestamp;
  readonly tenantId?: string;
}

export interface PromptProjection {
  readonly _id?: string;
  readonly prompt: string;
  readonly groupId?: string;
  readonly author?: string;
  readonly type?: PromptKind;
}

export interface PromptGroupRecord {
  readonly _id: string;
  readonly name: string;
  readonly author: string;
  readonly authorName: string;
  readonly numberOfGenerations?: number;
  readonly command?: string | null;
  readonly oneliner?: string;
  readonly category?: string;
  readonly productionId?: string | null;
  readonly productionPrompt?: PromptRecord | PromptProjection | null;
  readonly isPublic?: boolean;
  readonly createdAt?: PromptTimestamp;
  readonly updatedAt?: PromptTimestamp;
  readonly tenantId?: string;
  readonly source: PromptGroupSource;
  readonly sourcePromptName?: string;
  readonly sourceProjectId?: string;
  readonly sourceDestination?: string;
}

export type PromptSelection =
  | { readonly type: 'production' }
  | { readonly type: 'exact'; readonly promptId: string }
  /** Langfuse only; the native adapter returns `unsupported_selection` for it. */
  | { readonly type: 'version'; readonly version: number };

export interface NativeResolvedPrompt {
  readonly source: 'native';
  readonly groupId: string;
  readonly promptId: string;
  readonly prompt: string;
  readonly type: PromptKind;
}

/** A Langfuse prompt is always text: a chat prompt is rejected before it reaches here. */
export interface LangfuseResolvedPrompt {
  readonly source: 'langfuse';
  readonly groupId: string;
  readonly prompt: string;
  readonly type: 'text';
  readonly version: number;
  readonly labels: readonly string[];
  /** Deep link to this prompt in the Langfuse console (`getLangfusePromptUrl`). Present
   *  only when the adapter resolves it; the `/resolve` handler also strips it from a
   *  non-admin response. */
  readonly sourceUrl?: string;
}

export type ResolvedPrompt = NativeResolvedPrompt | LangfuseResolvedPrompt;

/** The raw creation body plus the server-supplied creator. */
export type CreatePromptGroupInput = Omit<TCreatePromptRecord, 'authorName'> & {
  readonly authorName?: string;
};

export interface AddPromptRevisionInput {
  readonly groupId: string;
  readonly prompt: { readonly prompt: string; readonly type: PromptKind };
  readonly author: string;
}

export interface PromptCreationResult {
  readonly prompt: PromptRecord | null;
  readonly group: PromptGroupRecord;
}

export interface PromptListResult {
  readonly data: readonly PromptGroupRecord[];
  readonly has_more: boolean;
  readonly after: string | null;
}

export interface PromptListInput {
  readonly accessibleIds: readonly string[];
  readonly publiclyAccessibleIds: readonly string[];
  readonly ownedPromptGroupIds: readonly string[];
  readonly name?: string;
  readonly category?: string;
  /** Page size; null requests the full catalog. */
  readonly limit: number | string | null;
  readonly after: string | null;
  readonly forReuse: boolean;
  readonly filters?: FiltersConfig;
}

export type PromptOperation = 'savePrompt' | 'makePromptProduction' | 'deletePrompt';

/** The identity a synced group is found or created by. */
export type PromptGroupSourceIdentity = {
  sourceDestination: string;
  sourceProjectId: string;
  sourcePromptName: string;
};

/** The input to `PromptService.importSourceGroup`: a source-pointer group's identity
 *  plus the display fields a found-or-created group is named and authored by. */
export type ImportSourceGroupInput = {
  readonly identity: PromptGroupSourceIdentity;
  readonly name: string;
  readonly author: string;
  readonly authorName: string;
};

/** `created` is a new group; `unchanged` covers both an existing match and a
 *  duplicate-key race lost to a concurrent insert; `skipped` is a document that
 *  failed validation and was never saved. */
export type PromptSourceImportOutcome = 'created' | 'unchanged' | 'skipped';

export type CreateSourceGroupResult =
  | { readonly ok: true; readonly value: { readonly _id: string } }
  | {
      readonly ok: false;
      readonly error:
        | { readonly code: 'duplicate' }
        | { readonly code: 'invalid'; readonly cause: unknown };
    };

export type PromptServiceError =
  | { readonly type: 'invalid_input'; readonly message: string; readonly details?: unknown }
  | { readonly type: 'blocked_content'; readonly finding: ProtectionFinding }
  | {
      readonly type: 'unavailable_selection';
      readonly reason: 'production' | 'revision';
    }
  | { readonly type: 'unsupported'; readonly operation: PromptOperation }
  /** The group is not `native`: an externally managed group rejects every mutation,
   *  including `savePrompt`, `updatePromptGroup`, `deletePromptGroup`,
   *  `makePromptProduction` and `deletePrompt`. */
  | { readonly type: 'read_only'; readonly source: PromptGroupSource }
  /** The selection is not valid for `source` (for example `version` on a native group,
   *  or `exact` on a Langfuse group). */
  | { readonly type: 'unsupported_selection'; readonly source: PromptGroupSource }
  /** Returned by the `allowedSources` check in `resolvePrompt`, before any adapter runs. */
  | { readonly type: 'unsupported_source'; readonly source: PromptGroupSource }
  | {
      readonly type: 'source_unavailable';
      readonly source: 'langfuse';
      readonly reason: 'disabled' | 'not_configured' | 'source_changed';
    }
  | { readonly type: 'source_not_found'; readonly source: 'langfuse' }
  | { readonly type: 'unsupported_content'; readonly reason: 'chat_prompt' };

export type PromptServiceResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: PromptServiceError };

/**
 * `makePromptProduction` carries `groupId` outside `value` so a caller can clear the
 * linked-instructions cache without changing `TMakePromptProductionResponse`, the HTTP body.
 * `groupId` is absent when the promoted revision does not exist.
 */
export type MakePromptProductionResult =
  | { readonly ok: true; readonly value: TMakePromptProductionResponse; readonly groupId?: string }
  | { readonly ok: false; readonly error: PromptServiceError };

export interface ResolvePromptInput {
  readonly groupId: string;
  readonly selection: PromptSelection;
  readonly loadedGroup?: PromptGroupRecord | null;
  readonly loadedRevision?: PromptRecord | null;
  readonly filters?: FiltersConfig;
  /** Restricts dispatch to these sources; any other source returns `unsupported_source`
   *  before an adapter or network call runs. Agent-link resolution passes `['native']`. */
  readonly allowedSources?: readonly PromptGroupSource[];
}

/**
 * Resolves a group's content for a selection. One adapter per `PromptGroupSource`; the
 * service picks it from `group.source` and dispatches the already-resolved `group`, so
 * an adapter never has to look its own group up.
 */
export interface PromptSourceAdapter {
  resolvePrompt(input: {
    readonly group: PromptGroupRecord;
    readonly selection: PromptSelection;
    readonly loadedRevision?: PromptRecord | null;
  }): Promise<PromptServiceResult<ResolvedPrompt>>;
}

/**
 * All local group and native-revision operations: the group-keyed storage methods and the
 * revision-keyed native methods. Three mutations, `savePrompt`, `makePromptProduction` and
 * `deletePrompt`, are optional: a store that cannot perform one leaves it out, and the
 * service returns an `unsupported` result. The service returns `read_only` for an
 * external group before calling `savePrompt`, `makePromptProduction`, `deletePrompt`,
 * `updatePromptGroup` or `deletePromptGroup` on a caller's request; the `importSourceGroup`
 * rollback deletes the external group it created without that check.
 */
export interface PromptStore {
  getPromptGroup(groupId: string): Promise<PromptGroupRecord | null>;
  getListPromptGroupsByAccess(
    input: Pick<PromptListInput, 'accessibleIds' | 'name' | 'category' | 'limit' | 'after'>,
  ): Promise<PromptListResult>;
  updatePromptGroup(groupId: string, updates: Record<string, unknown>): Promise<PromptGroupRecord>;
  incrementPromptGroupUsage(groupId: string): Promise<{ readonly numberOfGenerations: number }>;
  deletePromptGroup(groupId: string): Promise<{ readonly message: string }>;
  /** Finds a source-pointer group by its source identity, for `importSourceGroup`'s
   *  find-before-create step. */
  findSourceGroup(identity: PromptGroupSourceIdentity): Promise<{ readonly _id: string } | null>;
  /** Creates a source-pointer group: name and source identity only, never content.
   *  Returns a typed failure for a duplicate-key race or a document validation
   *  failure; any other failure throws. */
  createSourceGroup(input: ImportSourceGroupInput): Promise<CreateSourceGroupResult>;
  getPrompt(promptId: string): Promise<PromptRecord | null>;
  getPrompts(groupId: string): Promise<readonly PromptRecord[]>;
  createPromptGroup(input: CreatePromptGroupInput): Promise<PromptCreationResult>;
  savePrompt?(input: AddPromptRevisionInput): Promise<{ readonly prompt: PromptRecord }>;
  /** Throws when the revision does not exist. */
  makePromptProduction?(promptId: string): Promise<TMakePromptProductionResponse>;
  deletePrompt?(input: {
    readonly groupId: string;
    readonly promptId: string;
  }): Promise<TDeletePromptResponse>;
}

/** The data-schemas methods the prompt store and `createPromptService` use. */
export interface PromptDatabase {
  getPromptGroup(filter: { _id: string }): Promise<object | null>;
  getPrompt(filter: { _id: string }): Promise<object | null>;
  getPrompts(filter: { groupId: string }): Promise<readonly object[]>;
  createPromptGroup(input: {
    prompt: Record<string, unknown>;
    group: Record<string, unknown>;
    author: string;
    authorName?: string;
  }): Promise<{ prompt: object | null; group: object }>;
  savePrompt(input: {
    prompt: Record<string, unknown>;
    author: string;
  }): Promise<{ prompt: object }>;
  makePromptProduction(promptId: string): Promise<{ message: string }>;
  deletePrompt(input: {
    promptId: string;
    groupId: string;
  }): Promise<{ prompt: string; promptGroup?: { message: string; id: StoredId } }>;
  getListPromptGroupsByAccess(input: {
    accessibleIds: string[];
    name?: string;
    category?: string;
    limit: number | string | null;
    after: string | null;
  }): Promise<{ data: readonly object[]; has_more: boolean; after: string | null }>;
  updatePromptGroup(filter: { _id: string }, data: Record<string, unknown>): Promise<object>;
  incrementPromptGroupUsage(groupId: string): Promise<{ numberOfGenerations: number }>;
  deletePromptGroup(filter: { _id: string }): Promise<{ message: string }>;
  findLangfusePromptGroup(identity: PromptGroupSourceIdentity): Promise<{ _id: string } | null>;
  createLangfusePromptGroup(input: {
    name: string;
    author: string;
    authorName: string;
    sourceDestination: string;
    sourceProjectId: string;
    sourcePromptName: string;
  }): Promise<{ _id: string }>;
  /** Reads the deployment's base config, which the Langfuse adapter's source resolver
   *  checks for the prompt-sync switch. Returns the plain override document, not the
   *  Mongoose model `~/models` resolves it from. */
  findConfigByPrincipal(
    principalType: PrincipalType,
    principalId: string,
  ): Promise<StoredBaseConfig | null>;
}

export interface PromptServiceAdapters {
  /** All local group and native-revision storage. */
  readonly store: PromptStore;
  /** The content source per `PromptGroupSource`, resolving a selection only. */
  readonly sources: Record<PromptGroupSource, PromptSourceAdapter>;
  readonly grantCreatorOwnership: (input: {
    readonly userId: string;
    readonly groupId: string;
  }) => Promise<void>;
  /** Grants a PUBLIC viewer entry, for a source-pointer group just imported by
   *  `importSourceGroup`. */
  readonly grantPublicViewer: (input: { readonly groupId: string }) => Promise<void>;
  readonly logger: {
    warn(message: string, ...args: unknown[]): void;
    error(message: string, ...args: unknown[]): void;
  };
}
