import { z } from 'zod';

export const DEFAULT_SCHEDULE_MCP_CONSENT_LIFETIME_HOURS = 168;

/**
 * Sent as the description of an approval request that a schedule's owner asked for. It is a
 * code, not a sentence: the approval card shows its own wording in the reader's language.
 */
export const SCHEDULE_APPROVAL_REASON = 'schedule_owner_approval';

const identifier = z.string().trim().min(1).max(256);
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const safeUrl = z
  .string()
  .url()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        ['https:', 'http:'].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    } catch {
      return false;
    }
  });

export const scheduledMCPFailureReasonSchema = z.enum([
  'consent_missing',
  'consent_expired',
  'consent_revoked',
  'binding_mismatch',
  'rbac_denied',
  'tool_policy_denied',
  'approval_required',
  'credential_missing',
  'credential_rejected',
  'resource_permission_denied',
  'provider_missing',
  'resource_unverified',
  'unsupported_mode',
  'dependency_unavailable',
]);
export type ScheduledMCPFailureReason = z.infer<typeof scheduledMCPFailureReasonSchema>;

export const scheduledMCPIdentitySchema = z
  .object({
    scheduleId: identifier,
    ownerId: identifier,
    tenantId: identifier.nullable(),
    agentId: identifier,
    invocationMode: z.literal('delegated'),
  })
  .strict();
export type ScheduledMCPIdentity = z.infer<typeof scheduledMCPIdentitySchema>;

export const scheduledMCPResourceSchema = z
  .object({
    serverName: identifier,
    url: safeUrl,
    configurationRevision: identifier,
    credentialMode: z.enum([
      'stored_oauth',
      'browser_bearer',
      'renewable_obo',
      'resource_bearer',
      'static',
      'anonymous',
    ]),
    issuer: safeUrl.nullable(),
    audience: identifier.nullable(),
    scopes: z.array(identifier).max(128),
  })
  .strict();
export const scheduledMCPResourceBindingSchema = scheduledMCPResourceSchema.omit({
  serverName: true,
  configurationRevision: true,
});
export type ScheduledMCPResourceBinding = z.infer<typeof scheduledMCPResourceBindingSchema>;
export type ScheduledMCPResource = z.infer<typeof scheduledMCPResourceSchema>;
export type ScheduledMCPCredentialMode = ScheduledMCPResource['credentialMode'];

const MAX_AGENT_TOOLS = 256;
const MAX_SERVER_AGENTS = 100;
/**
 * The most distinct tools one server can hold across the agents that select them. Lists kept
 * per server, not per agent, are sized by it, so they can always represent a valid offer.
 */
export const MAX_SCHEDULED_MCP_SERVER_TOOLS = MAX_AGENT_TOOLS * MAX_SERVER_AGENTS;

export const scheduledMCPToolSelectionSchema = z
  .object({
    agentId: identifier,
    tools: z.array(identifier).min(1).max(MAX_AGENT_TOOLS),
  })
  .strict();
export type ScheduledMCPToolSelection = z.infer<typeof scheduledMCPToolSelectionSchema>;

export const scheduledMCPTargetSchema = z
  .object({
    resource: scheduledMCPResourceSchema,
    permittedTools: z.array(scheduledMCPToolSelectionSchema).min(1).max(MAX_SERVER_AGENTS),
    policyRevision: identifier,
  })
  .strict();
export type ScheduledMCPTarget = z.infer<typeof scheduledMCPTargetSchema>;

/** What an allowed tool looked like the first time an authorized run used it. */
export const scheduledMCPToolPinSchema = z
  .object({
    tool: identifier,
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type ScheduledMCPToolPin = z.infer<typeof scheduledMCPToolPinSchema>;

export const scheduledMCPConsentSchema = scheduledMCPTargetSchema
  .extend({
    id: identifier,
    revision: identifier,
    identity: scheduledMCPIdentitySchema,
    grantedAtMs: timestamp,
    absoluteExpiresAtMs: timestamp,
    revokedAtMs: timestamp.nullable(),
    /** Absent until a tool is first used. One entry per tool, never rewritten. */
    definitions: z.array(scheduledMCPToolPinSchema).max(MAX_SCHEDULED_MCP_SERVER_TOOLS).optional(),
    /** Tools a run saw with a definition other than their pin. Refused until confirmed again. */
    changedTools: z.array(identifier).max(MAX_SCHEDULED_MCP_SERVER_TOOLS).optional(),
    /** Allowed tools the owner wants to approve call by call. A run pauses before each use. */
    askTools: z.array(identifier).max(MAX_SCHEDULED_MCP_SERVER_TOOLS).optional(),
  })
  .strict()
  .refine((value) => value.absoluteExpiresAtMs > value.grantedAtMs);
export type ScheduledMCPConsent = z.infer<typeof scheduledMCPConsentSchema>;

export const scheduledMCPEnrollmentSchema = z
  .object({
    version: z.literal(1),
    scheduleRevision: z.number().int().nonnegative(),
    revision: identifier,
    consents: z.array(scheduledMCPConsentSchema).min(1).max(32),
  })
  .strict();
export type ScheduledMCPEnrollment = z.infer<typeof scheduledMCPEnrollmentSchema>;

export const confirmScheduleMCPConsentSchema = z
  .object({
    offerDigest: z.string().regex(/^[a-f0-9]{64}$/),
    expectedRevision: identifier.nullable(),
    lifetimeHours: z.number().int().min(1).max(8760),
    /**
     * The tools the owner allows, by server, chosen from the offer. A server left out, or
     * listed with no tools, is not allowed. Anything not listed here is refused at run time.
     */
    allow: z
      .record(identifier, z.array(identifier).max(MAX_SCHEDULED_MCP_SERVER_TOOLS))
      .refine((value) => Object.keys(value).length <= 32)
      .refine((value) => Object.values(value).some((tools) => tools.length > 0)),
    /**
     * Of the allowed tools, the ones the owner wants to approve call by call, by server.
     * Each must also be listed in `allow`.
     */
    ask: z
      .record(identifier, z.array(identifier).max(MAX_SCHEDULED_MCP_SERVER_TOOLS))
      .refine((value) => Object.keys(value).length <= 32)
      .optional(),
  })
  .strict();
export type ConfirmScheduleMCPConsent = z.infer<typeof confirmScheduleMCPConsentSchema>;

export const revokeScheduleMCPConsentSchema = z.object({ expectedRevision: identifier }).strict();

export interface ScheduleMCPConsentView {
  state: 'missing' | 'active' | 'expired' | 'revoked' | 'changed' | 'unsupported';
  revision: string | null;
  expiresAtMs: number | null;
  /** With an offer, every server and tool the owner may choose from; otherwise the stored grant. */
  targets: ScheduledMCPTarget[];
  /** The tools the stored grant allows, by server. Empty when there is none. */
  allowed: Record<string, string[]>;
  /** Allowed tools whose definition changed since first use, by server. Refused until confirmed again. */
  changed: Record<string, string[]>;
  /** Allowed tools the stored grant asks the owner about before each use, by server. */
  asking: Record<string, string[]>;
  /** Whether a scheduled run can pause for the owner's approval on this deployment. */
  approval: boolean;
  /** With no grant: whether the schedule's MCP tools are refused until the owner confirms. */
  required: boolean;
  /** With no grant and not yet required: when the operator's deadline makes it so. */
  requireAfterMs: number | null;
  offer: { digest: string; maxLifetimeHours: number } | null;
}
