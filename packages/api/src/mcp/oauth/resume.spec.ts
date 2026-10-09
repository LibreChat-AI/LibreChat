import { StepTypes } from 'librechat-data-provider';

import type { Agents } from 'librechat-data-provider';
import type * as t from '~/types';

import { projectPendingMCPOAuthPrompts } from './resume';

const NOW = 1_800_000_000_000;

function runStep(id: string, index: number, serverName: string): Agents.RunStep {
  return {
    id,
    runId: 'USE_PRELIM_RESPONSE_MESSAGE_ID',
    index,
    type: StepTypes.TOOL_CALLS,
    stepDetails: {
      type: StepTypes.TOOL_CALLS,
      tool_calls: [{ id: `call-${id}`, name: `oauth_mcp_${serverName}`, args: '' }],
    },
  };
}

function authDelta(
  id: string,
  serverName: string,
  authURL: string,
  expiresAt = NOW + 60_000,
): NonNullable<t.ResumeState['replayEvents']>[number] {
  return {
    event: 'on_run_step_delta',
    data: {
      id,
      delta: {
        type: 'tool_calls',
        tool_calls: [{ name: `oauth_mcp_${serverName}`, args: '' }],
        auth: authURL,
        expires_at: expiresAt,
      },
    },
  };
}

describe('projectPendingMCPOAuthPrompts', () => {
  test('projects the latest active prompt for each OAuth step in content order', () => {
    const steps = [runStep('step-slack', 2, 'Slack'), runStep('step-drive', 1, 'Drive')];
    const replayEvents = [
      authDelta('step-slack', 'Slack', 'https://old.example.com/oauth'),
      authDelta('step-drive', 'Drive', 'https://drive.example.com/oauth'),
      authDelta('step-slack', 'Slack', 'https://slack.example.com/oauth'),
    ];

    expect(projectPendingMCPOAuthPrompts(replayEvents, steps, NOW)).toEqual([
      {
        stepId: 'step-drive',
        runId: 'USE_PRELIM_RESPONSE_MESSAGE_ID',
        index: 1,
        toolCallId: 'call-step-drive',
        toolName: 'oauth_mcp_Drive',
        authURL: 'https://drive.example.com/oauth',
        expiresAt: NOW + 60_000,
      },
      {
        stepId: 'step-slack',
        runId: 'USE_PRELIM_RESPONSE_MESSAGE_ID',
        index: 2,
        toolCallId: 'call-step-slack',
        toolName: 'oauth_mcp_Slack',
        authURL: 'https://slack.example.com/oauth',
        expiresAt: NOW + 60_000,
      },
    ]);
  });

  test('omits completed and expired prompts', () => {
    const steps = [runStep('step-complete', 0, 'Slack'), runStep('step-expired', 1, 'Drive')];
    const replayEvents = [
      authDelta('step-complete', 'Slack', 'https://slack.example.com/oauth'),
      authDelta('step-expired', 'Drive', 'https://drive.example.com/oauth', NOW - 1),
      {
        event: 'on_run_step_completed',
        data: {
          result: {
            id: 'step-complete',
            index: 0,
            tool_call: {
              id: 'call-step-complete',
              name: 'oauth_mcp_Slack',
              output: 'OAuth authentication completed',
            },
          },
        },
      },
    ];

    expect(projectPendingMCPOAuthPrompts(replayEvents, steps, NOW)).toBeUndefined();
  });

  test('ignores an auth delta without durable run-step identity', () => {
    expect(
      projectPendingMCPOAuthPrompts(
        [authDelta('missing-step', 'Slack', 'https://slack.example.com/oauth')],
        [],
        NOW,
      ),
    ).toBeUndefined();
  });

  test('does not let an earlier completed flow hide a newer prompt on the same step', () => {
    const nextStep = runStep('step-slack', 0, 'Slack');
    nextStep.stepDetails = {
      type: StepTypes.TOOL_CALLS,
      tool_calls: [{ id: 'call-new', name: 'oauth_mcp_Slack', args: '' }],
    };
    const replayEvents = [
      authDelta('step-slack', 'Slack', 'https://slack.example.com/oauth'),
      {
        event: 'on_run_step_completed',
        data: {
          result: {
            id: 'step-slack',
            index: 0,
            tool_call: {
              id: 'call-old',
              name: 'oauth_mcp_Slack',
              output: 'OAuth authentication completed',
            },
          },
        },
      },
    ];

    expect(projectPendingMCPOAuthPrompts(replayEvents, [nextStep], NOW)).toEqual([
      expect.objectContaining({
        stepId: 'step-slack',
        toolCallId: 'call-new',
        authURL: 'https://slack.example.com/oauth',
      }),
    ]);
  });
});
