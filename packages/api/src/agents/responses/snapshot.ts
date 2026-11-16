import { z } from 'zod';

const part = z
  .object({
    type: z.string(),
    text: z.string().optional(),
    refusal: z.string().optional(),
  })
  .passthrough();
const item = z
  .object({
    id: z.string(),
    type: z.string(),
    arguments: z.string().optional(),
    call_id: z.string().optional(),
    content: z.array(part).optional(),
    summary: z.array(part).optional(),
  })
  .passthrough();
const snapshot = z
  .object({
    id: z.string(),
    object: z.literal('response'),
    status: z.enum(['completed', 'failed', 'incomplete']),
    output: z.array(item),
  })
  .passthrough();

/** Project the ordinary controller's completed JSON delivery without changing model execution. */
export function* responseSnapshotEvents(value: unknown): Generator<Record<string, unknown>> {
  const response = snapshot.parse(value);
  let sequence = 0;
  const event = (type: string, fields: Record<string, unknown>) => ({
    ...fields,
    type,
    sequence_number: sequence++,
  });
  const initial = { ...response, status: 'in_progress', output: [], usage: null };
  yield event('response.created', { response: initial });
  yield event('response.in_progress', { response: initial });
  function* content(
    output: z.infer<typeof item>,
    output_index: number,
    parts: z.infer<typeof part>[],
    summary = false,
  ): Generator<Record<string, unknown>> {
    for (const [index, part] of parts.entries()) {
      const location = {
        item_id: output.id,
        output_index,
        ...(summary ? { summary_index: index } : { content_index: index }),
      };
      const lifecycle = summary ? 'reasoning_summary_part' : 'content_part';
      const empty = {
        ...part,
        ...(part.text !== undefined ? { text: '' } : {}),
        ...(part.refusal !== undefined ? { refusal: '' } : {}),
      };
      yield event(`response.${lifecycle}.added`, { ...location, part: empty });
      if (part.text !== undefined || part.refusal !== undefined) {
        let channel = 'output_text';
        if (summary) channel = 'reasoning_summary_text';
        else if (part.type === 'reasoning_text') channel = 'reasoning';
        else if (part.type === 'refusal') channel = 'refusal';
        const probabilities = channel === 'output_text' ? { logprobs: part.logprobs ?? [] } : {};
        yield event(`response.${channel}.delta`, {
          ...location,
          ...probabilities,
          delta: part.text ?? part.refusal,
        });
        yield event(`response.${channel}.done`, {
          ...location,
          ...probabilities,
          ...(channel === 'refusal' ? { refusal: part.refusal } : { text: part.text }),
        });
      }
      yield event(`response.${lifecycle}.done`, { ...location, part });
    }
  }
  for (const [output_index, output] of response.output.entries()) {
    const started = {
      ...output,
      status: 'in_progress',
      ...(output.content ? { content: [] } : {}),
      ...(output.summary ? { summary: [] } : {}),
      ...(output.type === 'function_call' ? { arguments: '' } : {}),
    };
    yield event('response.output_item.added', { output_index, item: started });
    if (output.content) yield* content(output, output_index, output.content);
    if (output.summary) yield* content(output, output_index, output.summary, true);
    if (output.type === 'function_call') {
      const location = { item_id: output.id, output_index, call_id: output.call_id };
      yield event('response.function_call_arguments.delta', {
        ...location,
        delta: output.arguments,
      });
      yield event('response.function_call_arguments.done', {
        ...location,
        arguments: output.arguments,
      });
    }
    yield event('response.output_item.done', { output_index, item: output });
  }
  yield event(`response.${response.status}`, { response });
}
