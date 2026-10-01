import { logger } from '@librechat/data-schemas';
import {
  LANGFUSE_TRACE_CONVERSATION_METADATA_FIELDS,
  LANGFUSE_TRACE_USER_METADATA_FIELDS,
  LANGFUSE_TRACE_USER_ID_FIELDS,
} from 'librechat-data-provider';
import type {
  LangfuseTraceConversationMetadataField,
  LangfuseTraceUserMetadataField,
  LangfuseTraceUserIdField,
  LangfuseTraceConfig,
  DeepPartial,
} from 'librechat-data-provider';
import type { IUser } from '@librechat/data-schemas';
import { normalizeString } from '~/utils/text';

export type LangfuseTraceUser = Partial<Pick<IUser, LangfuseTraceUserMetadataField>>;

/** Request-scoped values a run may expose as trace metadata when allowlisted. */
export type LangfuseTraceContext = Partial<
  Record<LangfuseTraceConversationMetadataField, string | null>
>;

export type LangfuseTraceIdentityConfig = DeepPartial<LangfuseTraceConfig>;

const DEFAULT_USER_ID_FIELD = 'id';
/** Fields already reported (unset or unknown), so a busy deployment logs each once. */
const userIdFieldWarnings = new Set<string>();
/**
 * Runtime copies of the schema allowlists. Admin config patches persist
 * overrides without schema validation, so a field name is checked again at
 * the point it is read rather than trusted from the config type.
 */
const USER_ID_FIELDS = new Set<string>(LANGFUSE_TRACE_USER_ID_FIELDS);
const USER_METADATA_FIELDS = new Set<string>(LANGFUSE_TRACE_USER_METADATA_FIELDS);
const CONVERSATION_METADATA_FIELDS = new Set<string>(LANGFUSE_TRACE_CONVERSATION_METADATA_FIELDS);

function isUserIdField(field: string): field is LangfuseTraceUserIdField {
  return USER_ID_FIELDS.has(field);
}

/**
 * Whether traces are exported under the internal user id: no field is set, or
 * the set field is one the exporter ignores. A user without a value for an
 * allowed field also keeps the internal id, but that is per user and not known
 * from config alone.
 */
export function exportsInternalTraceUserId(
  trace: LangfuseTraceIdentityConfig | undefined,
): boolean {
  const field = trace?.userIdField;
  return field == null || field === DEFAULT_USER_ID_FIELD || !isUserIdField(String(field));
}

function isUserMetadataField(field: unknown): field is LangfuseTraceUserMetadataField {
  return typeof field === 'string' && USER_METADATA_FIELDS.has(field);
}

function isConversationMetadataField(
  field: unknown,
): field is LangfuseTraceConversationMetadataField {
  return typeof field === 'string' && CONVERSATION_METADATA_FIELDS.has(field);
}

function warnOnce(field: string, message: string): void {
  if (userIdFieldWarnings.has(field)) {
    return;
  }
  userIdFieldWarnings.add(field);
  logger.warn(`[langfuse] trace.userIdField "${field}" ${message} Reported once per field.`);
}
const USER_METADATA_PREFIX = 'librechat.user.';
const CONVERSATION_METADATA_KEYS: Record<LangfuseTraceConversationMetadataField, string> = {
  conversationId: 'librechat.conversation.id',
  endpoint: 'librechat.endpoint',
  endpointType: 'librechat.endpoint.type',
  provider: 'librechat.provider',
  model: 'librechat.model',
  modelLabel: 'librechat.model.label',
  spec: 'librechat.spec',
};

/**
 * The trace `userId` a deployment selected, or `undefined` to keep the SDK's
 * default (`configurable.user_id`, the internal id). A user without a value
 * for the configured field also yields `undefined`, so the trace still
 * carries the internal id rather than no user at all.
 */
export function resolveLangfuseTraceUserId(
  trace: LangfuseTraceIdentityConfig | undefined,
  user: LangfuseTraceUser | undefined,
): string | undefined {
  const field: string = trace?.userIdField ?? DEFAULT_USER_ID_FIELD;
  if (field === DEFAULT_USER_ID_FIELD) {
    return undefined;
  }
  if (!isUserIdField(field)) {
    warnOnce(field, 'is not an allowed user field; the trace keeps the internal id.');
    return undefined;
  }
  const value = normalizeString(user?.[field]);
  if (value == null) {
    warnOnce(
      field,
      `is unset for user ${user?.id ?? '(unknown)'}; the trace keeps the internal id.`,
    );
  }
  return value;
}

/**
 * Allowlisted user and request fields as trace metadata. Only fields the
 * deployment listed are read, blank values are skipped, and `undefined` is
 * returned when nothing survives so callers can leave the metadata untouched.
 */
export function buildLangfuseTraceMetadata({
  trace,
  user,
  context,
}: {
  trace: LangfuseTraceIdentityConfig | undefined;
  user: LangfuseTraceUser | undefined;
  context: LangfuseTraceContext | undefined;
}): Record<string, string> | undefined {
  const metadata: Record<string, string> = {};
  for (const field of new Set(trace?.userMetadataFields ?? [])) {
    const value = isUserMetadataField(field) ? normalizeString(user?.[field]) : undefined;
    if (value != null) {
      metadata[`${USER_METADATA_PREFIX}${field}`] = value;
    }
  }
  for (const field of new Set(trace?.conversationMetadataFields ?? [])) {
    if (!isConversationMetadataField(field)) {
      continue;
    }
    const value = normalizeString(context?.[field]);
    if (value != null) {
      metadata[CONVERSATION_METADATA_KEYS[field]] = value;
    }
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}
