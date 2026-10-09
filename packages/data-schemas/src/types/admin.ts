import type { PrincipalType, PrincipalModel, TCustomConfig } from 'librechat-data-provider';

/* ── Capability types (defined alongside the SystemCapabilities constant) ── */

export type {
  BaseSystemCapability,
  ConfigAssignTarget,
  ConfigSection,
  SystemCapability,
  CapabilityCategory,
} from '~/admin/capabilities';

/* ── Admin API response types ───────────────────────────────────────── */

/** Config document as returned by the admin API (no Mongoose internals). */
export type AdminConfig = {
  _id: string;
  principalType: PrincipalType;
  principalId: string;
  principalModel: PrincipalModel;
  priority: number;
  overrides: Partial<TCustomConfig>;
  isActive: boolean;
  configVersion: number;
  tenantId?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type AdminConfigListResponse = {
  configs: AdminConfig[];
};

export type AdminConfigResponse = {
  config: AdminConfig;
};

export type AdminConfigDeleteResponse = {
  success: boolean;
};

/* ── Audit log taxonomy ─────────────────────────────────────────────── */

/**
 * High-level domains an audit entry can belong to. The audit log is a
 * general-purpose, append-only compliance record; new domains (agent runs,
 * tool/MCP calls, config and permission changes, approvals) are added here as
 * the surface grows, without reshaping the record.
 */
export const AUDIT_CATEGORIES = [
  'grant',
  'agent_run',
  'tool_call',
  'mcp',
  'config',
  'permission',
  'auth',
  'approval',
] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

/**
 * Single source of truth for the audit-action enum. Actions are namespaced
 * `<category>.<verb>` so the registry stays readable as it grows and every
 * action maps unambiguously to a category. The Mongoose schema enum and the
 * HTTP handler's whitelist both consume this constant so they cannot drift.
 */
export const AUDIT_ACTIONS = [
  'grant.assigned',
  'grant.removed',
  'permission.insights_assigned',
  'permission.insights_removed',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** Maps each action to its category so writers never pass both. */
export const AUDIT_ACTION_CATEGORY: Record<AuditAction, AuditCategory> = {
  'grant.assigned': 'grant',
  'grant.removed': 'grant',
  'permission.insights_assigned': 'permission',
  'permission.insights_removed': 'permission',
};

/** Result of the audited operation. Kept first-class instead of being encoded
 * into the action so `allowed` vs `denied` vs `failed` is queryable. */
export const AUDIT_OUTCOMES = ['success', 'failure', 'denied', 'pending'] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

/** Coarse severity for SIEM routing and alerting. */
export const AUDIT_SEVERITIES = ['info', 'warning', 'critical'] as const;
export type AuditSeverity = (typeof AUDIT_SEVERITIES)[number];

/**
 * Who initiated the action. Non-human actors are first-class: a scheduled job,
 * an agent acting autonomously, an internal service, or a webhook are all
 * representable without forcing a `User` id.
 */
export const AUDIT_ACTOR_TYPES = [
  'user',
  'system',
  'agent',
  'service',
  'schedule',
  'webhook',
  'api',
] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

/** Primitive metadata values; event-specific payload is a flat string-keyed map
 * (e.g. `{ capability }` for grants, `{ runId, triggerType }` for agent runs). */
export type AuditMetadataValue = string | number | boolean | null;
export type AuditMetadata = Record<string, AuditMetadataValue>;

/** Denormalized actor identity captured at write time. */
export type AuditActor = {
  type: AuditActorType;
  /** Stable id (user id, service-account id, agent id); absent for anonymous
   * system events. */
  id?: string;
  /** Display name captured at write time so the record stays readable after the
   * underlying principal is renamed or deleted. */
  name: string;
};

/** Generic target of the action — not principal-locked, so it can describe a
 * role, agent, MCP server, config section, etc. */
export type AuditTarget = {
  type: string;
  id?: string;
  name?: string;
};

/** Request context for forensic joins and SIEM correlation. */
export type AuditContext = {
  /** Correlation id (`x-request-id` / `x-correlation-id`). */
  requestId?: string;
  ip?: string;
  userAgent?: string;
  sessionId?: string;
};

/** Per-entry tamper-evidence surfaced to readers. The full chain is verifiable
 * via the verify endpoint. */
export type AuditIntegrity = {
  /** Monotonic per-chain sequence number (1-based). */
  seq: number;
  /** SHA-256 of this entry's canonical content linked to `prevHash`. */
  hash: string;
  /** Hash of the previous entry in the chain (genesis links to a zero hash). */
  prevHash: string;
};

/** SystemGrant document as returned by the admin API. */
export type AdminSystemGrant = {
  id: string;
  principalType: PrincipalType;
  principalId: string;
  capability: string;
  grantedBy?: string;
  grantedAt: string;
  expiresAt?: string;
};

/** Audit log entry as returned by the admin API. */
export type AdminAuditLogEntry = {
  id: string;
  schemaVersion: number;
  category: AuditCategory;
  action: AuditAction;
  outcome: AuditOutcome;
  severity: AuditSeverity;
  actor: AuditActor;
  target: AuditTarget;
  metadata?: AuditMetadata;
  context?: AuditContext;
  /** Absent = platform-operator entry; present = tenant-scoped entry. */
  tenantId?: string;
  integrity: AuditIntegrity;
  /** `createdAt` as an ISO 8601 string. */
  timestamp: string;
};

/** Group as returned by the admin API. */
export type AdminGroup = {
  id: string;
  name: string;
  description: string;
  memberCount: number;
  topMembers: { name: string }[];
  isActive: boolean;
};

/** Member entry as returned by the admin API for group/role membership lists. */
export type AdminMember = {
  userId: string;
  name: string;
  email: string;
  avatarUrl?: string;
  joinedAt?: string;
};

/** Full user info returned by the admin user list endpoint. */
export type AdminUserListItem = {
  id: string;
  name: string;
  username: string;
  email: string;
  avatar: string;
  role: string;
  provider: string;
  createdAt?: string;
  updatedAt?: string;
};

/** Minimal user info returned by user search endpoints. */
export type AdminUserSearchResult = {
  id: string;
  name: string;
  email: string;
  username?: string;
  avatarUrl?: string;
};
