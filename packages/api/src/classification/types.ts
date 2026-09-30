export type ClassificationJson =
  | string
  | number
  | boolean
  | null
  | ClassificationJson[]
  | { [key: string]: ClassificationJson };

export type ClassificationText =
  | string
  | ClassificationJson[]
  | { [key: string]: ClassificationJson };

export type ClassificationState = ClassificationText;

export interface BooleanQuestion {
  type: 'boolean';
  instructions: ClassificationText;
  criteria?: {
    true?: ClassificationText;
    false?: ClassificationText;
  };
}

export interface ChoiceQuestion {
  type: 'choice';
  instructions: ClassificationText;
  criteria: Record<string, ClassificationText | null>;
}

export type ClassificationQuestion = BooleanQuestion | ChoiceQuestion;

export interface BooleanAnswer {
  type: 'boolean';
  probability: number;
}

export interface ChoiceAnswer {
  type: 'choice';
  choice: string;
  /** `null` when the provider cannot measure it, which is not the same as 0. */
  confidence: number | null;
  probabilities: Record<string, number>;
}

export type ClassificationAnswer = BooleanAnswer | ChoiceAnswer;

export interface ClassificationUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ClassificationRequest {
  state: ClassificationState;
  questions: Record<string, ClassificationQuestion>;
  signal?: AbortSignal;
  label?: string;
  /** Overrides the provider's timeout for this request alone. */
  timeoutMs?: number;
}

export interface ClassificationResult {
  model: string;
  answers: Record<string, ClassificationAnswer>;
  usage: ClassificationUsage;
}

export interface Classifier {
  readonly id: string;
  readonly model: string;
  classify(request: ClassificationRequest): Promise<ClassificationResult>;
}

export type ClassificationFailure =
  | 'timeout'
  | 'aborted'
  | 'rate_limited'
  | 'unauthorized'
  | 'bad_request'
  | 'server_error'
  | 'network'
  | 'unsupported_question'
  | 'malformed_response';

export class ClassificationError extends Error {
  readonly failure: ClassificationFailure;
  readonly provider: string;
  readonly status?: number;
  retryAfterMs?: number;

  constructor(
    failure: ClassificationFailure,
    message: string,
    options?: { provider?: string; status?: number },
  ) {
    super(message);
    this.name = 'ClassificationError';
    this.failure = failure;
    this.provider = options?.provider ?? 'unknown';
    this.status = options?.status;
  }
}

export function isBooleanAnswer(answer: ClassificationAnswer | undefined): answer is BooleanAnswer {
  return answer?.type === 'boolean';
}

export function isChoiceAnswer(answer: ClassificationAnswer | undefined): answer is ChoiceAnswer {
  return answer?.type === 'choice';
}
