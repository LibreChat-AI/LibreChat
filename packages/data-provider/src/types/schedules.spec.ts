import { z } from 'zod';
import {
  getScheduleMCPDisabledReason,
  isScheduleMCPAuthorizationFailure,
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
