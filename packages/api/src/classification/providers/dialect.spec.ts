import { toWireQuestion, readAnswer } from './dialect';
import { boolean, choice } from '../questions';

describe('toWireQuestion', () => {
  it('keeps the port vocabulary by default', () => {
    expect(toWireQuestion(boolean('durable?'), 'port').type).toBe('boolean');
  });

  it('renames a yes/no question for System One', () => {
    expect(toWireQuestion(boolean('durable?'), 'systemone').type).toBe('noul');
  });

  it('leaves a choice alone in either dialect', () => {
    const pick = choice('which', { a: null, b: null });

    expect(toWireQuestion(pick, 'systemone').type).toBe('choice');
    expect(toWireQuestion(pick, 'port').criteria).toEqual({ a: null, b: null });
  });

  it('omits criteria when the question carries none', () => {
    expect(toWireQuestion(boolean('durable?'), 'port')).not.toHaveProperty('criteria');
  });
});

describe('readAnswer', () => {
  it('reads a port boolean', () => {
    expect(readAnswer({ type: 'boolean', probability: 0.9 }, 'port')).toEqual({
      type: 'boolean',
      probability: 0.9,
    });
  });

  it('reads a System One noul as a boolean', () => {
    expect(readAnswer({ type: 'noul', noul: 0.9 }, 'systemone')).toEqual({
      type: 'boolean',
      probability: 0.9,
    });
  });

  it('does not read a noul when the port dialect was asked for', () => {
    expect(readAnswer({ type: 'noul', noul: 0.9 }, 'port')).toBeNull();
  });

  it('reports an unmeasured confidence as null rather than zero', () => {
    const answer = readAnswer(
      { type: 'choice', choice: 'a', probabilities: { a: 1 } },
      'systemone',
    );

    expect(answer).toEqual({
      type: 'choice',
      choice: 'a',
      confidence: null,
      probabilities: { a: 1 },
    });
  });

  it('drops an answer it cannot read rather than inventing one', () => {
    expect(readAnswer({ type: 'choice' }, 'port')).toBeNull();
    expect(readAnswer(null, 'port')).toBeNull();
    expect(readAnswer('yes', 'port')).toBeNull();
  });
});
