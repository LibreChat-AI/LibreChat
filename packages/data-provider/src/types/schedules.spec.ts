import { z } from 'zod';
import {
  getScheduleMCPDisabledReason,
  isScheduleMCPAuthorizationFailure,
  projectScheduleMCPReceipt,
  readScheduleMCPOutcomes,
  scheduleMCPOutcomeSchema,
} from './schedules';

it('preserves the previous wire status while providing an optional unattended-auth diagnosis', () => {
  const outcome = {
    server: 'Graph',
    status: 'mcp_configuration_missing' as const,
    detail: 'unattended_auth_required' as const,
  };
  // Represents the schema used by an open tab from before this feature.
  const previousClientSchema = z.object({
    server: z.string(),
    agentId: z.string().optional(),
    status: z.enum([
      'ready',
      'mcp_reauth_required',
      'mcp_configuration_missing',
      'mcp_permission_denied',
      'mcp_unavailable',
    ]),
  });
  expect(previousClientSchema.array().parse([outcome])).toEqual([
    { server: 'Graph', status: 'mcp_configuration_missing' },
  ]);
  expect(scheduleMCPOutcomeSchema.parse(outcome)).toEqual(outcome);
  expect(getScheduleMCPDisabledReason([outcome])).toBe('mcp_configuration_missing');
  expect(
    readScheduleMCPOutcomes(`mcp_configuration_missing: ${JSON.stringify([outcome])}`),
  ).toEqual([outcome]);
});

it('recognizes durable structured denials without treating readiness snapshots as receipts', () => {
  const failure = {
    server: 'warehouse',
    status: 'mcp_reauth_required' as const,
    reason: 'credential_rejected' as const,
    automaticReplay: false as const,
  };
  expect(isScheduleMCPAuthorizationFailure(failure)).toBe(true);
  expect(isScheduleMCPAuthorizationFailure({ ...failure, status: 'ready' })).toBe(false);
  expect(
    isScheduleMCPAuthorizationFailure({ server: 'warehouse', status: 'mcp_reauth_required' }),
  ).toBe(false);
  expect(
    isScheduleMCPAuthorizationFailure({
      server: 'warehouse',
      status: 'mcp_configuration_missing',
      detail: 'unattended_auth_required',
    }),
  ).toBe(true);
});

describe('a server a run was started without', () => {
  const skipped = {
    server: 'Notion',
    status: 'mcp_reauth_required' as const,
    reason: 'consent_revoked' as const,
    recovery: 'authorize' as const,
    automaticReplay: false as const,
    skipped: true as const,
  };
  const { skipped: _mark, ...denied } = skipped;

  it('is carried on the wire with its reason', () => {
    expect(scheduleMCPOutcomeSchema.parse(skipped)).toEqual(skipped);
  });

  it('is not a denial, where the same outcome without the mark is', () => {
    expect(isScheduleMCPAuthorizationFailure(denied)).toBe(true);
    expect(isScheduleMCPAuthorizationFailure(skipped)).toBe(false);
    expect(
      isScheduleMCPAuthorizationFailure({ ...skipped, detail: 'unattended_auth_required' }),
    ).toBe(false);
  });

  it('does not suspend the schedule, and does not hide a server that does', () => {
    expect(getScheduleMCPDisabledReason([denied])).toBe('mcp_reauth_required');
    expect(getScheduleMCPDisabledReason([skipped])).toBeUndefined();
    expect(
      getScheduleMCPDisabledReason([
        skipped,
        { server: 'Linear', status: 'mcp_configuration_missing' },
      ]),
    ).toBe('mcp_configuration_missing');
  });

  it('leaves a successful run successful, and stays apart from a denial of the same server', () => {
    expect(projectScheduleMCPReceipt({ status: 'success', mcp: [skipped] })).toEqual({
      status: 'success',
      mcp: [skipped],
    });
    const settled = projectScheduleMCPReceipt({ status: 'success', mcp: [skipped] }, [denied]);
    expect(settled.status).toBe('error');
    expect(settled.mcp).toEqual([skipped, denied]);
  });
});
