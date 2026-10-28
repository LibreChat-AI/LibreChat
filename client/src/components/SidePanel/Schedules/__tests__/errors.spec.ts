import { readScheduleMCPOutcomes } from 'librechat-data-provider';
import {
  scheduleMCPErrorMessage,
  scheduleMCPErrorOutcomes,
  scheduleMCPCardOutcomes,
  scheduleMCPRecoveryOutcomes,
  scheduleMCPNeedsAgentRecovery,
  scheduleDisabledMCPLabel,
} from '../errors';

it('shows localized recovery reasons and exact server names', () => {
  const error = Object.assign(new Error('private transport details'), {
    response: {
      data: {
        mcp: [
          { server: 'Notion', status: 'mcp_reauth_required' },
          { server: 'ClickHouse', status: 'ready' },
        ],
      },
    },
  });
  expect(scheduleMCPErrorMessage(error, (key) => key)).toBe('Notion: com_ui_schedule_mcp_reauth');
  expect(scheduleMCPErrorOutcomes(error)).toEqual([
    { server: 'Notion', status: 'mcp_reauth_required' },
    { server: 'ClickHouse', status: 'ready' },
  ]);
});

it('drops an immediate MCP failure after polling reports a newer run', () => {
  const immediate = {
    lastRunKey: '2026-09-09T12:00:00.000Z:error',
    outcomes: [{ server: 'Notion', status: 'mcp_unavailable' as const }],
  };
  const prior = {
    enabled: true,
    lastRun: { firedAt: '2026-09-09T12:00:00.000Z', status: 'error' as const },
  };
  const recovered = {
    enabled: true,
    lastRun: { firedAt: '2026-09-09T13:00:00.000Z', status: 'success' as const },
  };

  expect(scheduleMCPCardOutcomes(prior, immediate)).toEqual(immediate.outcomes);
  expect(scheduleMCPCardOutcomes(recovered, immediate)).toEqual([]);
});

it('preserves descendant owners from immediate admission errors', () => {
  const error = Object.assign(new Error('missing tool'), {
    response: {
      data: {
        mcp: [
          {
            server: 'Notion',
            agentId: 'research-agent',
            status: 'mcp_configuration_missing',
          },
        ],
      },
    },
  });

  expect(scheduleMCPErrorOutcomes(error)).toEqual([
    {
      server: 'Notion',
      agentId: 'research-agent',
      status: 'mcp_configuration_missing',
    },
  ]);
});

it('ignores unrelated and malformed server errors', () => {
  expect(
    scheduleMCPErrorMessage(new Error('private transport details'), (key) => key),
  ).toBeUndefined();
  expect(readScheduleMCPOutcomes('mcp_reauth_required: [malformed')).toEqual([]);
});

it('preserves the permanent unattended-auth failure across API errors and saved runs', () => {
  const outcomes = [
    {
      server: 'Company Graph',
      status: 'mcp_configuration_missing' as const,
      detail: 'unattended_auth_required' as const,
    },
  ];
  const error = Object.assign(new Error('Internal OBO credentials'), {
    response: { status: 400, data: { code: 'mcp_configuration_missing', mcp: outcomes } },
  });
  expect(scheduleMCPErrorMessage(error, (key) => key)).toBe(
    'Company Graph: com_ui_schedule_mcp_unattended_auth',
  );
  expect(scheduleMCPErrorOutcomes(error)).toEqual(outcomes);
  expect(
    scheduleMCPRecoveryOutcomes({
      enabled: false,
      disabledReason: 'mcp_configuration_missing',
      lastRun: {
        status: 'error',
        firedAt: new Date().toISOString(),
        error:
          'mcp_configuration_missing: [{"server":"Company Graph","status":"mcp_configuration_missing","detail":"unattended_auth_required"}]',
      },
    }),
  ).toEqual(outcomes);
  expect(scheduleMCPNeedsAgentRecovery(outcomes)).toBe(false);
  expect(scheduleDisabledMCPLabel('mcp_configuration_missing', outcomes)).toBe(
    'com_ui_schedule_disabled_mcp_unattended_auth',
  );
  expect(
    scheduleDisabledMCPLabel('mcp_configuration_missing', [
      { server: 'Graph', status: 'mcp_configuration_missing' },
    ]),
  ).toBeUndefined();
});

it('explains transient MCP infrastructure failures without server outcomes', () => {
  const error = Object.assign(new Error('private infrastructure details'), {
    response: { status: 503, data: { code: 'mcp_unavailable' } },
  });
  expect(scheduleMCPErrorMessage(error, (key) => key)).toBe('com_ui_schedule_mcp_unavailable');
});

it('explains administrator-revoked MCP permission', () => {
  const error = Object.assign(new Error('permission denied'), {
    response: {
      status: 400,
      data: { mcp: [{ server: 'Notion', status: 'mcp_permission_denied' }] },
    },
  });
  expect(scheduleMCPErrorMessage(error, (key) => key)).toBe(
    'Notion: com_ui_schedule_mcp_permission',
  );
});

it('restores saved per-server failure outcomes on the schedule card', () => {
  const outcomes = [
    { server: 'Notion', agentId: 'research-agent', status: 'mcp_reauth_required' as const },
  ];
  const lastRun = {
    status: 'error' as const,
    firedAt: new Date().toISOString(),
    error: 'mcp_reauth_required: [legacy malformed payload',
    mcp: outcomes,
  };
  expect(
    scheduleMCPRecoveryOutcomes({
      enabled: false,
      disabledReason: 'mcp_reauth_required',
      lastRun,
    }),
  ).toEqual(outcomes);
  expect(
    scheduleMCPRecoveryOutcomes({
      enabled: false,
      disabledReason: 'permission_revoked',
      lastRun,
    }),
  ).toEqual([]);
  expect(scheduleMCPRecoveryOutcomes({ enabled: true, lastRun })).toEqual([]);
});

it('does not label unrelated schedule 503 responses as MCP failures', () => {
  const error = Object.assign(new Error('scheduler unavailable'), {
    response: { status: 503, data: { code: 'SCHEDULES_UNAVAILABLE' } },
  });
  expect(scheduleMCPErrorMessage(error, (key) => key)).toBeUndefined();
});

it('does not offer agent reconnection for permission-only recovery', () => {
  expect(
    scheduleMCPNeedsAgentRecovery([{ server: 'Notion', status: 'mcp_permission_denied' }]),
  ).toBe(false);
  expect(scheduleMCPNeedsAgentRecovery([{ server: 'Notion', status: 'mcp_reauth_required' }])).toBe(
    true,
  );
});
