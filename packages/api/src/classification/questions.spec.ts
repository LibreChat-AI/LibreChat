import type { ChoiceAnswer, BooleanAnswer } from './types';
import { choice, isTrue, ranked, boolean } from './questions';

describe('question builders', () => {
  it('builds a boolean without criteria', () => {
    expect(boolean('Is this urgent?')).toEqual({
      type: 'boolean',
      instructions: 'Is this urgent?',
    });
  });

  it('builds a boolean with criteria', () => {
    expect(boolean('Is this urgent?', { true: 'yes means', false: 'no means' })).toEqual({
      type: 'boolean',
      instructions: 'Is this urgent?',
      criteria: { true: 'yes means', false: 'no means' },
    });
  });

  it('builds a choice', () => {
    expect(choice('Which team?', { billing: 'money', tech: 'bugs' })).toEqual({
      type: 'choice',
      instructions: 'Which team?',
      criteria: { billing: 'money', tech: 'bugs' },
    });
  });
});

describe('isTrue', () => {
  const answer: BooleanAnswer = { type: 'boolean', probability: 0.8 };

  it('compares against the threshold inclusively', () => {
    expect(isTrue(answer, 0.8)).toBe(true);
    expect(isTrue(answer, 0.81)).toBe(false);
  });

  it('is false for a missing answer', () => {
    expect(isTrue(undefined, 0)).toBe(false);
  });
});

describe('choice helpers', () => {
  const answer: ChoiceAnswer = {
    type: 'choice',
    choice: 'tech',
    confidence: 0.7,
    probabilities: { tech: 0.7, billing: 0.2, sales: 0.05 },
  };

  it('ranks options most probable first', () => {
    expect(ranked(answer)).toEqual(['tech', 'billing', 'sales']);
  });

  it('drops options under the floor', () => {
    expect(ranked(answer, 0.1)).toEqual(['tech', 'billing']);
  });

  it('handles a missing answer', () => {
    expect(ranked(undefined)).toEqual([]);
  });
});
