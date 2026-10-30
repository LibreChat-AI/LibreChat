import { getSafeErrorMetadata } from '~/utils/errors';
import { Constants, Time } from 'librechat-data-provider';
import { GraphEvents, StepTypes } from '@librechat/agents';
import type { OAuthStartHandler } from '../types';
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

interface OAuthPromptStep {
  stepId: string;
  toolCall: OAuthToolCall;
}

/** Reauthentication owns a separate replayable step, never the model tool's result. */
export function createMCPReauthenticationPrompt({
  serverName,
  toolCallId,
  stepId,
  runId,
  createStart,
  createEnd,
  logger,
}: {
  serverName: string;
  logger?: { warn: (message: string, metadata: ReturnType<typeof getSafeErrorMetadata>) => void };
  toolCallId?: string;
  stepId?: string;
  runId: string;
  createStart: (step: OAuthPromptStep) => OAuthStartHandler;
  createEnd: (step: OAuthPromptStep) => () => Promise<void>;
}): {
  start: OAuthStartHandler;
  end: () => Promise<void>;
  run: <Result>(operation: () => Promise<Result>) => Promise<Result>;
} {
  const callId = `oauth:${toolCallId ?? stepId ?? runId}`;
  const step = {
    stepId: `${buildMCPAuthStepId(serverName)}:${callId}`,
    toolCall: buildMCPAuthToolCall({ id: callId, serverName }),
  };
  const emitStart = createStart(step);
  const emitEnd = createEnd(step);
  let pending = false;
  const start: OAuthStartHandler = async (...args) => {
    pending = true;
    await emitStart(...args);
  };
  let retiring: Promise<void> | undefined;
  const end = async () => {
    if (!pending) return;
    if (retiring) return retiring;
    retiring = (async () => {
      try {
        await emitEnd();
        pending = false;
      } catch (error) {
        // Keep the prompt retryable without replacing an already-performed tool's outcome.
        try {
          logger?.warn('[MCP OAuth] Prompt retirement unavailable', getSafeErrorMetadata(error));
        } catch {
          // Diagnostic transport cannot become the tool outcome either.
        }
      }
    })();
    try {
      await retiring;
    } finally {
      retiring = undefined;
    }
  };
  return {
    start,
    end,
    async run<Result>(operation: () => Promise<Result>): Promise<Result> {
      try {
        return await operation();
      } finally {
        // Timeout and caller cancellation retire only this prompt, not a shared OAuth flow.
        await end();
      }
    },
  };
}

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

interface OAuthEventTransport {
  res: import('node:http').ServerResponse;
  sendEvent: (res: import('node:http').ServerResponse, event: t.ServerSentEvent) => void;
  jobs: Pick<import('~/stream/GenerationJobManager').GenerationJobManagerClass, 'emitChunk'>;
  streamId?: string | null;
  jobCreatedAt?: number;
}

function createOAuthEventEmitter(transport: OAuthEventTransport) {
  return async (event: t.ServerSentEvent): Promise<void> => {
    if (!transport.streamId) {
      transport.sendEvent(transport.res, event);
      return;
    }
    if (transport.jobCreatedAt == null) throw new Error('OAuth prompt generation is unavailable');
    await transport.jobs.emitChunk(transport.streamId, event, {
      expectedCreatedAt: transport.jobCreatedAt,
      durable: true,
    });
  };
}

export function createMCPAuthStepEmitter(
  input: OAuthEventTransport & Parameters<typeof buildMCPAuthRunStepEvent>[0],
): () => Promise<void> {
  const emit = createOAuthEventEmitter(input);
  return () => emit(buildMCPAuthRunStepEvent(input));
}

export function createMCPAuthDeltaEmitter(
  input: OAuthEventTransport & Pick<Parameters<typeof buildMCPAuthRunStepDeltaEvent>[0], 'stepId' | 'toolCall'>,
): OAuthStartHandler {
  const emit = createOAuthEventEmitter(input);
  return (authURL, options) => emit(buildMCPAuthRunStepDeltaEvent({ ...input, authURL, options }));
}

export function createMCPAuthEndEmitter(
  input: OAuthEventTransport & Parameters<typeof buildMCPAuthRunStepCompletedEvent>[0],
): () => Promise<void> {
  const emit = createOAuthEventEmitter(input);
  return () => emit(buildMCPAuthRunStepCompletedEvent({
    ...input,
    toolCall: { ...input.toolCall, output: 'OAuth authentication ended', type: 'tool_call' },
  }));
}
