import type { TClassificationProviderConfig } from 'librechat-data-provider';
import type { ClassificationAnswer, ClassificationQuestion } from '../types';

export type Dialect = NonNullable<TClassificationProviderConfig['dialect']>;

interface WireQuestion {
  type: string;
  instructions: unknown;
  criteria?: unknown;
}

interface WireAnswer {
  type?: unknown;
  probability?: unknown;
  noul?: unknown;
  choice?: unknown;
  confidence?: unknown;
  probabilities?: unknown;
}

/** System One calls a yes/no question a `noul`; the port calls it a boolean. */
export function toWireQuestion(question: ClassificationQuestion, dialect: Dialect): WireQuestion {
  const type = dialect === 'systemone' && question.type === 'boolean' ? 'noul' : question.type;
  return question.criteria == null
    ? { type, instructions: question.instructions }
    : { type, instructions: question.instructions, criteria: question.criteria };
}

export function readAnswer(answer: unknown, dialect: Dialect): ClassificationAnswer | null {
  if (answer == null || typeof answer !== 'object') {
    return null;
  }
  const record = answer as WireAnswer;
  const probabilities = (record.probabilities ?? {}) as Record<string, number>;
  const confidence = typeof record.confidence === 'number' ? record.confidence : null;

  const booleanType = dialect === 'systemone' ? 'noul' : 'boolean';
  const probability = dialect === 'systemone' ? record.noul : record.probability;
  if (record.type === booleanType && typeof probability === 'number') {
    return { type: 'boolean', probability };
  }
  if (record.type === 'choice' && typeof record.choice === 'string') {
    return { type: 'choice', choice: record.choice, confidence, probabilities };
  }
  return null;
}
