import {
  confirmScheduleMCPConsentSchema,
  scheduledMCPResourceSchema,
  scheduledMCPIdentitySchema,
  scheduledMCPEnrollmentSchema,
} from './scheduleConsent';
import { configSchema } from '../config';

it('keeps scheduled consent opt-in and bounds its absolute lifetime', () => {
  const config = configSchema.parse({
    version: '1.3.8',
    interface: { schedules: { mcpConsent: {} } },
  });
  expect(config.interface?.schedules).toMatchObject({
    mcpConsent: {},
  });
  expect(
    configSchema.safeParse({
      version: '1.3.8',
      interface: { schedules: { mcpConsent: { maxLifetimeHours: 0 } } },
    }).success,
  ).toBe(false);
});
it('requires an explicit tenant binding and delegated mode', () => {
  const identity = { scheduleId: 's', ownerId: 'u', agentId: 'a', invocationMode: 'delegated' };
  expect(scheduledMCPIdentitySchema.safeParse(identity).success).toBe(false);
  expect(scheduledMCPIdentitySchema.safeParse({ ...identity, tenantId: null }).success).toBe(true);
  expect(
    scheduledMCPIdentitySchema.safeParse({
      ...identity,
      tenantId: null,
      invocationMode: 'autonomous',
    }).success,
  ).toBe(false);
});
it.each([
  'https://token:secret@example.com/mcp',
  'https://example.com/mcp?token=secret',
  'file:///tmp/mcp',
  'https://example.com/mcp#secret',
])('rejects unsafe resource binding %s', (url) => {
  expect(
    scheduledMCPResourceSchema.safeParse({
      serverName: 'server',
      url,
      configurationRevision: 'v1',
      credentialMode: 'anonymous',
      issuer: null,
      audience: null,
      scopes: [],
    }).success,
  ).toBe(false);
});
it('accepts only a reviewed offer reference and bounded duration from the owner', () => {
  const valid = { offerDigest: 'a'.repeat(64), expectedRevision: null, lifetimeHours: 1 };
  expect(confirmScheduleMCPConsentSchema.safeParse(valid).success).toBe(true);
  expect(
    confirmScheduleMCPConsentSchema.safeParse({ ...valid, accessToken: 'secret' }).success,
  ).toBe(false);
  expect(
    confirmScheduleMCPConsentSchema.safeParse({ ...valid, lifetimeHours: Infinity }).success,
  ).toBe(false);
});
it('does not accept an unknown persisted consent version', () => {
  expect(
    scheduledMCPEnrollmentSchema.safeParse({ version: 2, revision: 'future', consents: [] })
      .success,
  ).toBe(false);
});
