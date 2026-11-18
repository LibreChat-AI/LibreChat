import type { Response, Usage, UsageTotals, OutputItem } from './types';
import type { ResponseAggregator } from './service';
import { combineResponseAccounting } from './accounting';

/** Restore tool state only; prior text/reasoning and item IDs remain immutable in the saved prefix. */
export function seedResponseAggregator(aggregator: ResponseAggregator, previous: Response): void {
  for (const item of previous.output) {
    if (item.type === 'function_call')
      aggregator.toolCalls.set(item.call_id, {
        id: item.call_id,
        name: item.name,
        arguments: item.arguments,
      });
    else if (item.type === 'function_call_output')
      aggregator.toolOutputs.set(item.call_id, item.output);
  }
}

function add(left: number, right: number): number {
  const result = left + right;
  if (
    !Number.isSafeInteger(left) ||
    left < 0 ||
    !Number.isSafeInteger(right) ||
    right < 0 ||
    !Number.isSafeInteger(result)
  )
    throw new Error('Response segment usage is invalid');
  return result;
}

function totals(left: UsageTotals, right: UsageTotals): UsageTotals {
  return {
    input_tokens: add(left.input_tokens, right.input_tokens),
    output_tokens: add(left.output_tokens, right.output_tokens),
    total_tokens: add(left.total_tokens, right.total_tokens),
  };
}

function usage(left: Usage | null, right: Usage | null): Usage | null {
  if (!left || !right) return null;
  return {
    ...totals(left, right),
    input_tokens_details: {
      cached_tokens: add(
        left.input_tokens_details.cached_tokens,
        right.input_tokens_details.cached_tokens,
      ),
    },
    output_tokens_details: {
      reasoning_tokens: add(
        left.output_tokens_details.reasoning_tokens,
        right.output_tokens_details.reasoning_tokens,
      ),
    },
    ...(left.primary && right.primary ? { primary: totals(left.primary, right.primary) } : {}),
    ...(left.subagent && right.subagent ? { subagent: totals(left.subagent, right.subagent) } : {}),
  };
}

function callKey(item: OutputItem): string | undefined {
  return item.type === 'function_call' || item.type === 'function_call_output'
    ? `${item.type}:${item.call_id}`
    : undefined;
}

/** Compose a new provider segment once with its saved prefix; never send old usage back to billing. */
export function combineResponseSegments(
  previous: Response,
  current: Response,
  segmentId: string,
): Response {
  if (previous.id !== current.id || previous.model !== current.model || !segmentId)
    throw new Error('Response segment identity changed');
  const output = [...previous.output];
  const calls = new Map<string, number>();
  const ids = new Set<string>();
  for (let index = 0; index < output.length; index++) {
    const item = output[index];
    ids.add(item.id);
    const key = callKey(item);
    if (key) calls.set(key, index);
  }
  for (const item of current.output) {
    const key = callKey(item);
    const index = key == null ? undefined : calls.get(key);
    if (index != null) {
      const prior = output[index];
      if (
        prior.type === 'function_call_output' &&
        item.type === 'function_call_output' &&
        prior.output !== item.output
      )
        throw new Error('Response tool result changed across segments');
      output[index] = { ...item, id: prior.id };
      continue;
    }
    if (
      item.type === 'message' &&
      item.role === 'assistant' &&
      item.content.length === 0 &&
      output.length > 0
    )
      continue;
    const id = ids.has(item.id) ? `${item.id}_${segmentId}` : item.id;
    if (ids.has(id)) throw new Error('Response segment item identity collided');
    if (key) calls.set(key, output.length);
    output.push({ ...item, id });
    ids.add(id);
  }
  return {
    ...current,
    created_at: previous.created_at,
    output,
    usage: usage(previous.usage, current.usage),
    accounting: combineResponseAccounting(previous.accounting, current.accounting),
  };
}
