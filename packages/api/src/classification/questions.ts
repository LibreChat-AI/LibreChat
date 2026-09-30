import type {
  ChoiceAnswer,
  BooleanAnswer,
  ChoiceQuestion,
  BooleanQuestion,
  ClassificationText,
} from './types';

export function boolean(
  instructions: ClassificationText,
  criteria?: { true?: ClassificationText; false?: ClassificationText },
): BooleanQuestion {
  return criteria == null
    ? { type: 'boolean', instructions }
    : { type: 'boolean', instructions, criteria };
}

export function choice(
  instructions: ClassificationText,
  criteria: Record<string, ClassificationText | null>,
): ChoiceQuestion {
  return { type: 'choice', instructions, criteria };
}

export function isTrue(answer: BooleanAnswer | undefined, threshold: number): boolean {
  return answer != null && answer.probability >= threshold;
}

/** Options above `floor`, most probable first. */
export function ranked(answer: ChoiceAnswer | undefined, floor = 0): string[] {
  if (answer == null) {
    return [];
  }
  return Object.entries(answer.probabilities)
    .filter(([, probability]) => probability >= floor)
    .sort((a, b) => b[1] - a[1])
    .map(([option]) => option);
}
