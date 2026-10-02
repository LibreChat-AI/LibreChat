import { z } from 'zod';

export const DEFAULT_SCHEDULE_MCP_CONSENT_LIFETIME_HOURS = 168;

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

export const scheduledMCPToolSelectionSchema = z
  .object({
    agentId: identifier,
    tools: z.array(identifier).min(1).max(256),
  })
  .strict();
export type ScheduledMCPToolSelection = z.infer<typeof scheduledMCPToolSelectionSchema>;

export const scheduledMCPTargetSchema = z
  .object({
    resource: scheduledMCPResourceSchema,
    permittedTools: z.array(scheduledMCPToolSelectionSchema).min(1).max(100),
    policyRevision: identifier,
  })
  .strict();
export type ScheduledMCPTarget = z.infer<typeof scheduledMCPTargetSchema>;

export const scheduledMCPConsentSchema = scheduledMCPTargetSchema
  .extend({
    id: identifier,
    revision: identifier,
    identity: scheduledMCPIdentitySchema,
    grantedAtMs: timestamp,
    absoluteExpiresAtMs: timestamp,
    revokedAtMs: timestamp.nullable(),
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
  })
  .strict();
export type ConfirmScheduleMCPConsent = z.infer<typeof confirmScheduleMCPConsentSchema>;

export const revokeScheduleMCPConsentSchema = z.object({ expectedRevision: identifier }).strict();

export interface ScheduleMCPConsentView {
  state: 'missing' | 'active' | 'expired' | 'revoked' | 'changed' | 'unsupported';
  revision: string | null;
  expiresAtMs: number | null;
  targets: ScheduledMCPTarget[];
  offer: { digest: string; maxLifetimeHours: number } | null;
}
