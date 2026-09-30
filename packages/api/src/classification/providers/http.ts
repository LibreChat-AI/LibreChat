import type {
  Classifier,
  ClassificationUsage,
  ClassificationAnswer,
  ClassificationResult,
  ClassificationRequest,
} from '../types';
import type { ProviderFetch } from './transport';
import type { Dialect } from './dialect';
import { toWireQuestion, readAnswer } from './dialect';
import { ClassificationError } from '../types';
import { createTransport } from './transport';

export const PROVIDER_ID = 'http';

export interface HttpProviderOptions {
  providerId?: string;
  apiKey: string;
  /** Full URL, not a base path. */
  endpoint: string;
  model?: string;
  /** Which wire vocabulary the endpoint speaks. */
  dialect?: Dialect;
  /** Nests `state` and `questions` under this key, for hosts that wrap them. */
  requestKey?: string;
  /** Reads the answer envelope from this key, for hosts that wrap the response. */
  responseKey?: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetch?: ProviderFetch;
  sleep?: (ms: number) => Promise<void>;
}

export function parseEnvelope(
  body: string,
  providerId: string,
  readOne: (answer: unknown) => ClassificationAnswer | null,
  responseKey?: string,
): ClassificationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new ClassificationError('malformed_response', 'response was not JSON', {
      provider: providerId,
    });
  }
  if (parsed == null || typeof parsed !== 'object') {
    throw new ClassificationError('malformed_response', 'response was not an object', {
      provider: providerId,
    });
  }
  const unwrapped =
    responseKey != null && responseKey !== ''
      ? ((parsed as Record<string, unknown>)[responseKey] ?? parsed)
      : parsed;
  const record = unwrapped as { model?: unknown; answers?: unknown; usage?: unknown };
  if (record.answers == null || typeof record.answers !== 'object') {
    throw new ClassificationError('malformed_response', 'response carried no answers', {
      provider: providerId,
    });
  }

  const answers: Record<string, ClassificationAnswer> = {};
  for (const [id, answer] of Object.entries(record.answers as Record<string, unknown>)) {
    const mapped = readOne(answer);
    if (mapped != null) {
      answers[id] = mapped;
    }
  }

  const raw = (record.usage ?? {}) as { input_tokens?: number; output_tokens?: number };
  const usage: ClassificationUsage = {
    inputTokens: raw.input_tokens ?? 0,
    outputTokens: raw.output_tokens ?? 0,
  };

  return {
    model: typeof record.model === 'string' ? record.model : 'unknown',
    answers,
    usage,
  };
}

export function createHttpClassifier(options: HttpProviderOptions): Classifier {
  const providerId = options.providerId ?? PROVIDER_ID;
  const send = createTransport({ ...options, providerId });
  const model = options.model ?? '';
  const dialect: Dialect = options.dialect ?? 'port';
  const { requestKey, responseKey } = options;

  return {
    id: providerId,
    model,
    async classify(request: ClassificationRequest): Promise<ClassificationResult> {
      const questions: Record<string, unknown> = {};
      for (const [id, question] of Object.entries(request.questions)) {
        questions[id] = toWireQuestion(question, dialect);
      }
      const inner = { state: request.state, questions };
      const payload = JSON.stringify({
        ...(model ? { model } : {}),
        ...(requestKey != null && requestKey !== '' ? { [requestKey]: inner } : inner),
      });
      const body = await send(
        payload,
        request.signal,
        request.label ?? 'classify',
        request.timeoutMs,
      );
      return parseEnvelope(body, providerId, (a) => readAnswer(a, dialect), responseKey);
    },
  };
}
