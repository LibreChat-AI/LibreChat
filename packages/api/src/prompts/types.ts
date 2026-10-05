import type {
  FiltersConfig,
  TCreatePromptRecord,
  TDeletePromptResponse,
  TMakePromptProductionResponse,
} from 'librechat-data-provider';
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
}

export type PromptSelection =
  | { readonly type: 'production' }
  | { readonly type: 'exact'; readonly promptId: string };

export interface ResolvedPrompt {
  readonly groupId: string;
  readonly promptId: string;
  readonly prompt: string;
  readonly type: PromptKind;
}

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

export type PromptServiceError =
  | { readonly type: 'invalid_input'; readonly message: string; readonly details?: unknown }
  | { readonly type: 'blocked_content'; readonly finding: ProtectionFinding }
  | {
      readonly type: 'unavailable_selection';
      readonly reason: 'production' | 'revision';
    }
  | { readonly type: 'unsupported'; readonly operation: PromptOperation };

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
}

/**
 * Operations that need source content. Mutations are optional: a source that cannot
 * perform one leaves it out, and the service returns an `unsupported` result.
 */
export interface PromptSourceAdapter {
  /** Returns null when the selection is not available in the group. */
  resolvePrompt(input: Omit<ResolvePromptInput, 'filters'>): Promise<ResolvedPrompt | null>;
  getPromptGroup(groupId: string): Promise<PromptGroupRecord | null>;
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

/** Local catalog operations that do not depend on the content source. */
export interface PromptCatalogStore {
  getListPromptGroupsByAccess(
    input: Pick<PromptListInput, 'accessibleIds' | 'name' | 'category' | 'limit' | 'after'>,
  ): Promise<PromptListResult>;
  updatePromptGroup(groupId: string, updates: Record<string, unknown>): Promise<PromptGroupRecord>;
  incrementPromptGroupUsage(groupId: string): Promise<{ readonly numberOfGenerations: number }>;
  deletePromptGroup(groupId: string): Promise<{ readonly message: string }>;
}

/** The data-schemas prompt methods the native adapter and catalog store use. */
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
}

export interface PromptServiceAdapters {
  /**
   * The content source for every prompt group. The service does not select a source for
   * each group: a group has no source field, and some operations receive only a revision ID.
   */
  readonly source: PromptSourceAdapter;
  readonly catalog: PromptCatalogStore;
  readonly grantCreatorOwnership: (input: {
    readonly userId: string;
    readonly groupId: string;
  }) => Promise<void>;
  readonly logger: {
    error(message: string, error: unknown): void;
  };
}
