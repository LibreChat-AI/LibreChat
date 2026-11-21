import { z } from 'zod';

export const DEFAULT_RUN_GRANT_LIFETIME_HOURS = 168;

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

export const runGrantFailureReasonSchema = z.enum([
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
export type RunGrantFailureReason = z.infer<typeof runGrantFailureReasonSchema>;

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

export const runGrantResourceSchema = z
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
export const runGrantResourceBindingSchema = runGrantResourceSchema.omit({
  serverName: true,
  configurationRevision: true,
});
export type RunGrantResourceBinding = z.infer<typeof runGrantResourceBindingSchema>;
export type RunGrantResource = z.infer<typeof runGrantResourceSchema>;
export type RunGrantCredentialMode = RunGrantResource['credentialMode'];

const MAX_AGENT_TOOLS = 256;
const MAX_SERVER_AGENTS = 100;
/**
 * The most distinct tools one server can hold across the agents that select them. Lists kept
 * per server, not per agent, are sized by it, so they can always represent a valid offer.
 */
export const MAX_RUN_GRANT_SERVER_TOOLS = MAX_AGENT_TOOLS * MAX_SERVER_AGENTS;

export const runGrantToolSelectionSchema = z
  .object({
    agentId: identifier,
    tools: z.array(identifier).min(1).max(MAX_AGENT_TOOLS),
  })
  .strict();
export type RunGrantToolSelection = z.infer<typeof runGrantToolSelectionSchema>;

export const runGrantTargetSchema = z
  .object({
    resource: runGrantResourceSchema,
    permittedTools: z.array(runGrantToolSelectionSchema).min(1).max(MAX_SERVER_AGENTS),
    policyRevision: identifier,
  })
  .strict();
export type RunGrantTarget = z.infer<typeof runGrantTargetSchema>;

/** What an allowed tool looked like the first time an authorized run used it. */
export const runGrantToolPinSchema = z
  .object({
    tool: identifier,
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type RunGrantToolPin = z.infer<typeof runGrantToolPinSchema>;

/**
 * Who a grant made for an API key acts for. The key and the agent are both part of the
 * subject: a key holds one grant per agent it may run.
 */
export const agentKeyMCPIdentitySchema = z
  .object({
    keyId: identifier,
    ownerId: identifier,
    tenantId: identifier.nullable(),
    agentId: identifier,
    invocationMode: z.literal('delegated'),
  })
  .strict();
export type AgentKeyMCPIdentity = z.infer<typeof agentKeyMCPIdentitySchema>;

/** A grant's subject: the schedule, or the API key and agent, a run acts for. */
export type RunGrantIdentity = ScheduledMCPIdentity | AgentKeyMCPIdentity;

function consentSchema<Identity extends z.ZodTypeAny>(identity: Identity) {
  return runGrantTargetSchema
    .extend({
      id: identifier,
      revision: identifier,
      identity,
      grantedAtMs: timestamp,
      absoluteExpiresAtMs: timestamp,
      revokedAtMs: timestamp.nullable(),
      /** Absent until a tool is first used. One entry per tool, never rewritten. */
      definitions: z.array(runGrantToolPinSchema).max(MAX_RUN_GRANT_SERVER_TOOLS).optional(),
      /** Tools a run saw with a definition other than their pin. Refused until confirmed again. */
      changedTools: z.array(identifier).max(MAX_RUN_GRANT_SERVER_TOOLS).optional(),
      /** Allowed tools the owner wants to approve call by call. A run pauses before each use. */
      askTools: z.array(identifier).max(MAX_RUN_GRANT_SERVER_TOOLS).optional(),
    })
    .strict()
    .refine((value) => value.absoluteExpiresAtMs > value.grantedAtMs);
}

function enrollmentSchema<Consent extends z.ZodTypeAny>(consent: Consent) {
  return z
    .object({
      version: z.literal(1),
      /** The subject's configuration generation the grant was made for. Zero where it has none. */
      scheduleRevision: z.number().int().nonnegative(),
      revision: identifier,
      /** One per MCP server the owner allowed. None, for a grant that allows other tools only. */
      consents: z.array(consent).max(32),
      /**
       * The agents' tools that are not MCP tools (code execution, web search, an action) that
       * the owner allowed, per agent. Absent: none of them is allowed.
       */
      tools: z.array(runGrantToolSelectionSchema).max(MAX_SERVER_AGENTS).optional(),
      /**
       * The whole agent, as it is and as it becomes: every tool, skill and MCP server its
       * agents use, including one added after the grant was made. `consents` lists the
       * servers known then, for the credentials a run acts with there; nothing is left out
       * for not being listed.
       */
      everything: z.literal(true).optional(),
      /**
       * The grant's own lifetime. A grant made before it was stored here has it only on its
       * consents, which every such grant has at least one of.
       */
      grantedAtMs: timestamp.optional(),
      absoluteExpiresAtMs: timestamp.optional(),
      revokedAtMs: timestamp.nullable().optional(),
    })
    .strict()
    .refine(
      (value) =>
        value.everything === true || value.consents.length > 0 || (value.tools?.length ?? 0) > 0,
    )
    .refine((value) => value.consents.length > 0 || value.absoluteExpiresAtMs != null);
}

/** Until when a grant allows anything, and whether its owner withdrew it. */
export function grantLifetime(grant: {
  absoluteExpiresAtMs?: number;
  revokedAtMs?: number | null;
  consents: readonly { absoluteExpiresAtMs: number; revokedAtMs: number | null }[];
}): { expiresAtMs: number; revoked: boolean } {
  return {
    expiresAtMs:
      grant.absoluteExpiresAtMs ??
      Math.min(...grant.consents.map((consent) => consent.absoluteExpiresAtMs)),
    revoked:
      grant.revokedAtMs != null || grant.consents.some((consent) => consent.revokedAtMs != null),
  };
}

export const scheduledMCPConsentSchema = consentSchema(scheduledMCPIdentitySchema);
export type ScheduledMCPConsent = z.infer<typeof scheduledMCPConsentSchema>;

export const scheduledMCPEnrollmentSchema = enrollmentSchema(scheduledMCPConsentSchema);
export type ScheduledMCPEnrollment = z.infer<typeof scheduledMCPEnrollmentSchema>;

export const agentKeyMCPEnrollmentSchema = enrollmentSchema(
  consentSchema(agentKeyMCPIdentitySchema),
);

/** One server's part of a grant, for whichever subject holds it. */
export type RunGrantConsent<Identity extends RunGrantIdentity = ScheduledMCPIdentity> = Omit<
  ScheduledMCPConsent,
  'identity'
> & { identity: Identity };

/** A whole grant, for whichever subject holds it. */
export type RunGrant<Identity extends RunGrantIdentity = ScheduledMCPIdentity> = Omit<
  ScheduledMCPEnrollment,
  'consents'
> & { consents: RunGrantConsent<Identity>[] };

const consentChoice = z.object({
  offerDigest: z.string().regex(/^[a-f0-9]{64}$/),
  expectedRevision: identifier.nullable(),
  lifetimeHours: z.number().int().min(1).max(8760),
  /**
   * The tools the owner allows, by server, chosen from the offer. A server left out, or
   * listed with no tools, is not allowed. Anything not listed here is refused at run time.
   */
  allow: z
    .record(identifier, z.array(identifier).max(MAX_RUN_GRANT_SERVER_TOOLS))
    .refine((value) => Object.keys(value).length <= 32),
  /**
   * Of the allowed tools, the ones the owner wants to approve call by call, by server.
   * Each must also be listed in `allow`.
   */
  ask: z
    .record(identifier, z.array(identifier).max(MAX_RUN_GRANT_SERVER_TOOLS))
    .refine((value) => Object.keys(value).length <= 32)
    .optional(),
  /**
   * Of the offered tools that are not MCP tools, the ones the owner allows. Left out, the
   * stored grant's choice is kept for the tools still on offer.
   */
  tools: z.array(identifier).max(MAX_AGENT_TOOLS).optional(),
  /**
   * The whole agent, including what is added to it later. Nothing is chosen one by one with
   * it, so `allow` is empty and `tools` is left out; `ask` may still name tools on offer.
   */
  everything: z.literal(true).optional(),
});

interface Choice {
  allow: Record<string, string[]>;
  tools?: string[];
  everything?: true;
}

/** Something must be allowed: the whole agent, or else an MCP tool or one of the other tools. */
const allowsSomething = (value: Choice): boolean =>
  value.everything === true
    ? Object.keys(value.allow).length === 0 && value.tools == null
    : Object.values(value.allow).some((tools) => tools.length > 0) ||
      (value.tools?.length ?? 0) > 0;

export const confirmRunGrantSchema = consentChoice.strict().refine(allowsSomething);
export type ConfirmRunGrant = z.infer<typeof confirmRunGrantSchema>;

/**
 * The owner's choice for a schedule that is being created, made from the offer for its agent.
 * There is no stored grant yet, so no revision to expect.
 */
export const scheduleAuthorizationSchema = consentChoice
  .omit({ expectedRevision: true })
  .strict()
  .refine(allowsSomething);
export type ScheduleAuthorization = z.infer<typeof scheduleAuthorizationSchema>;

/**
 * The owner's choice sent with an edit of a schedule. The edit ends the grant the schedule
 * had, so the choice is made again in the same step. With the agent unchanged it is made
 * from the schedule's own offer and names the stored grant (`expectedRevision`); with
 * another agent picked it is made from that agent's offer, as for a new schedule.
 */
export const scheduleReauthorizationSchema = consentChoice
  .extend({ expectedRevision: identifier.nullable().optional() })
  .strict()
  .refine(allowsSomething);
export type ScheduleReauthorization = z.infer<typeof scheduleReauthorizationSchema>;

/** Asks what the owner could allow a schedule of this agent, before the schedule exists. */
export const scheduleOfferRequestSchema = z.object({ agent_id: identifier }).strict();

export const revokeRunGrantSchema = z.object({ expectedRevision: identifier }).strict();

export interface RunGrantView {
  state: 'missing' | 'active' | 'expired' | 'revoked' | 'changed' | 'unsupported';
  revision: string | null;
  expiresAtMs: number | null;
  /** With an offer, every server and tool the owner may choose from; otherwise the stored grant. */
  targets: RunGrantTarget[];
  /** The tools the stored grant allows, by server. Empty when there is none. */
  allowed: Record<string, string[]>;
  /** Allowed tools whose definition changed since first use, by server. Refused until confirmed again. */
  changed: Record<string, string[]>;
  /** Allowed tools the stored grant asks the owner about before each use, by server. */
  asking: Record<string, string[]>;
  /**
   * The agents' tools that are not MCP tools: every one the owner may choose from, and the
   * ones the stored grant allows.
   */
  tools: {
    offered: string[];
    allowed: string[];
    /**
     * The MCP servers the agents use, by name. An MCP tool listed in `offered` comes as the
     * key the agent has it by; these say where the tool's name ends and its server's begins,
     * which the key alone does not when a name contains the delimiter.
     */
    servers?: string[];
  };
  /** Whether the stored grant is for the whole agent, including what is added to it later. */
  everything: boolean;
  /** Whether a scheduled run can pause for the owner's approval on this deployment. */
  approval: boolean;
  /** With no grant: whether the schedule's MCP tools are refused until the owner confirms. */
  required: boolean;
  /** With no grant and not yet required: when the operator's deadline makes it so. */
  requireAfterMs: number | null;
  /** `everything`: the grant may be made for the whole agent, not only tool by tool. */
  offer: { digest: string; maxLifetimeHours: number; everything?: true } | null;
}

/**
 * The names these exports had before they were named for what they are: the grant a subject's
 * runs act under, whichever subject holds it. Kept so that code outside this repository that
 * imports them keeps compiling. Nothing in this repository uses them.
 */
/** @deprecated Use `RunGrantIdentity`. */
export type MCPGrantIdentity = RunGrantIdentity;
/** @deprecated Use `RunGrantConsent`. */
export type MCPGrantConsent<Identity extends RunGrantIdentity = ScheduledMCPIdentity> =
  RunGrantConsent<Identity>;
/** @deprecated Use `RunGrant`. */
export type MCPGrantEnrollment<Identity extends RunGrantIdentity = ScheduledMCPIdentity> =
  RunGrant<Identity>;
/** @deprecated Use `runGrantFailureReasonSchema`. */
export const scheduledMCPFailureReasonSchema = runGrantFailureReasonSchema;
/** @deprecated Use `RunGrantFailureReason`. */
export type ScheduledMCPFailureReason = RunGrantFailureReason;
/** @deprecated Use `runGrantResourceSchema`. */
export const scheduledMCPResourceSchema = runGrantResourceSchema;
/** @deprecated Use `runGrantResourceBindingSchema`. */
export const scheduledMCPResourceBindingSchema = runGrantResourceBindingSchema;
/** @deprecated Use `RunGrantResourceBinding`. */
export type ScheduledMCPResourceBinding = RunGrantResourceBinding;
/** @deprecated Use `RunGrantResource`. */
export type ScheduledMCPResource = RunGrantResource;
/** @deprecated Use `RunGrantCredentialMode`. */
export type ScheduledMCPCredentialMode = RunGrantCredentialMode;
/** @deprecated Use `MAX_RUN_GRANT_SERVER_TOOLS`. */
export const MAX_SCHEDULED_MCP_SERVER_TOOLS = MAX_RUN_GRANT_SERVER_TOOLS;
/** @deprecated Use `runGrantToolSelectionSchema`. */
export const scheduledMCPToolSelectionSchema = runGrantToolSelectionSchema;
/** @deprecated Use `RunGrantToolSelection`. */
export type ScheduledMCPToolSelection = RunGrantToolSelection;
/** @deprecated Use `runGrantTargetSchema`. */
export const scheduledMCPTargetSchema = runGrantTargetSchema;
/** @deprecated Use `RunGrantTarget`. */
export type ScheduledMCPTarget = RunGrantTarget;
/** @deprecated Use `runGrantToolPinSchema`. */
export const scheduledMCPToolPinSchema = runGrantToolPinSchema;
/** @deprecated Use `RunGrantToolPin`. */
export type ScheduledMCPToolPin = RunGrantToolPin;
/** @deprecated Use `RunGrantView`. */
export type ScheduleMCPConsentView = RunGrantView;
/** @deprecated Use `confirmRunGrantSchema`. */
export const confirmScheduleMCPConsentSchema = confirmRunGrantSchema;
/** @deprecated Use `ConfirmRunGrant`. */
export type ConfirmScheduleMCPConsent = ConfirmRunGrant;
/** @deprecated Use `revokeRunGrantSchema`. */
export const revokeScheduleMCPConsentSchema = revokeRunGrantSchema;
/** @deprecated Use `DEFAULT_RUN_GRANT_LIFETIME_HOURS`. */
export const DEFAULT_SCHEDULE_MCP_CONSENT_LIFETIME_HOURS = DEFAULT_RUN_GRANT_LIFETIME_HOURS;
