import { Constants, Time } from 'librechat-data-provider';
import { GraphEvents, StepTypes } from '@librechat/agents';
import type * as t from '~/types';
import { buildOAuthToolCallName, splitMCPToolKey } from '~/mcp/utils';

export type OAuthPromptOptions = {
  expiresAt?: number;
};

export type OAuthToolCall = {
  id?: string;
  name: string;
  type: 'tool_call' | 'tool_call_chunk';
  args?: string;
  output?: string;
};

export function getOAuthPromptExpiresAt(
  options?: OAuthPromptOptions,
  now: number = Date.now(),
): number {
  return typeof options?.expiresAt === 'number' && Number.isFinite(options.expiresAt)
    ? options.expiresAt
    : now + Time.TWO_MINUTES;
}

export function getMCPServerNamesFromTools(
  tools?: unknown[] | null,
  knownServerNames?: readonly string[],
): Set<string> {
  const serverNames = new Set<string>();

  for (const tool of tools ?? []) {
    if (typeof tool !== 'string') {
      continue;
    }

    const [, serverName] = splitMCPToolKey(tool, knownServerNames);
    if (!serverName) {
      continue;
    }

    serverNames.add(serverName);
  }

  return serverNames;
}

export function buildMCPAuthStepId(serverName: string): string {
  return `step_oauth_login_${serverName}`;
}

export function buildMCPAuthToolCall({
  id,
  args,
  output,
  serverName,
  type = 'tool_call_chunk',
}: {
  id?: string;
  args?: string;
  output?: string;
  serverName: string;
  type?: OAuthToolCall['type'];
}): OAuthToolCall {
  return {
    ...(id != null ? { id } : {}),
    name: buildOAuthToolCallName(serverName),
    ...(args != null ? { args } : {}),
    ...(output != null ? { output } : {}),
    type,
  };
}

export function buildMCPAuthRunStepEvent({
  runId = Constants.USE_PRELIM_RESPONSE_MESSAGE_ID,
  stepId,
  toolCall,
  index = 0,
}: {
  runId?: string | null;
  stepId: string;
  toolCall: OAuthToolCall;
  index?: number;
}): t.ServerSentEvent {
  return {
    event: GraphEvents.ON_RUN_STEP,
    data: {
      runId,
      id: stepId,
      type: StepTypes.TOOL_CALLS,
      index,
      stepDetails: {
        type: StepTypes.TOOL_CALLS,
        tool_calls: [toolCall],
      },
    },
  };
}

export function buildMCPAuthRunStepDeltaEvent({
  authURL,
  stepId,
  toolCall,
  options,
}: {
  authURL: string;
  stepId: string;
  toolCall: OAuthToolCall;
  options?: OAuthPromptOptions;
}): t.ServerSentEvent {
  return {
    event: GraphEvents.ON_RUN_STEP_DELTA,
    data: {
      id: stepId,
      delta: {
        type: StepTypes.TOOL_CALLS,
        tool_calls: [{ ...toolCall, args: '' }],
        auth: authURL,
        expires_at: getOAuthPromptExpiresAt(options),
      },
    },
  };
}

export function buildMCPAuthRunStepEndDeltaEvent({
  stepId,
  toolCall,
}: {
  stepId: string;
  toolCall: OAuthToolCall;
}): t.ServerSentEvent {
  return {
    event: GraphEvents.ON_RUN_STEP_DELTA,
    data: {
      id: stepId,
      delta: {
        type: StepTypes.TOOL_CALLS,
        tool_calls: [{ ...toolCall }],
      },
    },
  };
}

export function buildMCPAuthRunStepCompletedEvent({
  stepId,
  toolCall,
  index = 0,
}: {
  stepId: string;
  toolCall: OAuthToolCall;
  index?: number;
}): t.ServerSentEvent {
  return {
    event: GraphEvents.ON_RUN_STEP_COMPLETED,
    data: {
      result: {
        id: stepId,
        index,
        tool_call: toolCall,
      },
    },
  };
}
