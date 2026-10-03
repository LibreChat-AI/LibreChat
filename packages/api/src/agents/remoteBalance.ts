import type { BaseMessage, UsageMetadata } from '@librechat/agents/langchain/messages';
import type { BalanceConfig } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { BalanceReservation, CheckBalanceDeps } from '~/middleware/checkBalance';
import type { ServerRequest } from '~/types/http';
import { checkBalance } from '~/middleware/checkBalance';
import { countTokens } from '~/utils/tokenizer';

export type RemoteAgentBalanceDeps = Omit<CheckBalanceDeps, 'balanceConfig'>;

type PromptMessages = ReadonlyArray<{ role?: string; content?: unknown }>;

export interface RemoteAgentBalanceParams {
  req: ServerRequest;
  res: Response;
  user: string;
  balanceConfig?: BalanceConfig | null;
  model?: string;
  endpoint?: string;
  endpointTokenConfig?: unknown;
  instructions?: string;
  messages: PromptMessages;
}

export interface UnreportedUsageParams {
  /** The run's collected usage; an estimate is appended to it when nothing was reported */
  collectedUsage: UsageMetadata[];
  instructions?: string;
  /** The request's messages, as sent to the model */
  messages: PromptMessages;
  /** The messages the run produced (`run.getRunMessages()`) */
  runMessages?: ReadonlyArray<BaseMessage>;
}

/** Collects the text of a message: string content, or the text or reasoning of each part. */
function getMessageText(content: unknown): string[] {
  if (typeof content === 'string') {
    return content.length > 0 ? [content] : [];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  return content.flatMap((part) => {
    const text = part?.text ?? part?.think ?? part?.thinking;
    return typeof text === 'string' && text.length > 0 ? [text] : [];
  });
}

function getPromptText(instructions: string | undefined, messages: PromptMessages): string {
  return [
    ...getMessageText(instructions),
    ...messages.flatMap((message) => getMessageText(message?.content)),
  ].join('\n');
}

/** The text the model wrote during the run: its answers, reasoning and tool-call arguments. */
function getOutputText(runMessages: ReadonlyArray<BaseMessage>): string {
  return runMessages
    .filter((message) => message?._getType?.() === 'ai')
    .flatMap((message) => [
      ...getMessageText(message.content),
      ...((message as { tool_calls?: Array<{ name?: string; args?: unknown }> }).tool_calls ?? [])
        .flatMap((call) => [call.name ?? '', JSON.stringify(call.args ?? {})])
        .filter((text) => text.length > 0),
    ])
    .join('\n');
}

/**
 * Admits a remote (API key) agent request against the user's balance before the run starts,
 * as the chat UI does for every turn: the estimated prompt cost is reserved, a due auto-refill is
 * applied, and a user without enough credits is refused with a `token_balance` violation.
 * Resolves to `undefined` when balances are disabled; otherwise the caller releases the
 * reservation once the run's usage has been recorded.
 */
export async function reserveRemoteAgentBalance(
  params: RemoteAgentBalanceParams,
  deps: RemoteAgentBalanceDeps,
): Promise<BalanceReservation | undefined> {
  const { balanceConfig } = params;
  if (!balanceConfig?.enabled) {
    return undefined;
  }

  return checkBalance(
    {
      req: params.req,
      res: params.res,
      txData: {
        user: params.user,
        tokenType: 'prompt',
        amount: await countTokens(getPromptText(params.instructions, params.messages)),
        model: params.model,
        endpoint: params.endpoint,
        endpointTokenConfig: params.endpointTokenConfig,
      },
    },
    { ...deps, balanceConfig },
  );
}

/**
 * Some providers report no token usage, such as an OpenAI-compatible server that streams
 * without `stream_options.include_usage`. The chat UI then falls back to a tokenizer estimate
 * of the turn; this gives remote (API key) runs the same fallback, so the run is still recorded
 * and billed instead of counting as zero tokens. Usage that any model call reported is left
 * as it is.
 */
export async function addEstimatedUsageIfUnreported({
  collectedUsage,
  instructions,
  messages,
  runMessages,
}: UnreportedUsageParams): Promise<void> {
  const reported = collectedUsage.some(
    (usage) => (usage?.input_tokens ?? 0) > 0 || (usage?.output_tokens ?? 0) > 0,
  );
  if (reported) {
    return;
  }

  const input_tokens = await countTokens(getPromptText(instructions, messages));
  const output_tokens = await countTokens(getOutputText(runMessages ?? []));
  collectedUsage.push({ input_tokens, output_tokens, total_tokens: input_tokens + output_tokens });
}
