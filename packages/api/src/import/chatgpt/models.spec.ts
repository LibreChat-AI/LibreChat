import { resolveModel } from './models';

describe('resolveModel', () => {
  it('renders minor versions with a dot', () => {
    expect(resolveModel('gpt-5-5-thinking', 'gpt-4o')).toEqual({
      model: 'gpt-5-5-thinking',
      sender: 'GPT-5.5 Thinking',
    });
    expect(resolveModel('gpt-4-1', 'gpt-4o')).toEqual({
      model: 'gpt-4-1',
      sender: 'GPT-4.1',
    });
  });

  it('keeps single-segment versions unchanged', () => {
    expect(resolveModel('gpt-5', 'gpt-4o').sender).toBe('GPT-5');
    expect(resolveModel('gpt-4o', 'gpt-4o').sender).toBe('GPT-4o');
    expect(resolveModel('gpt-4o-mini', 'gpt-4o').sender).toBe('GPT-4o mini');
  });

  it('handles reasoning families that are not gpt-prefixed', () => {
    expect(resolveModel('o3', 'gpt-4o').sender).toBe('o3');
    expect(resolveModel('o4-mini-high', 'gpt-4o').sender).toBe('o4-mini-high');
  });

  it('maps the deep research slug', () => {
    expect(resolveModel('research', 'gpt-4o').sender).toBe('Deep Research');
  });

  it('falls back when the slug is missing', () => {
    expect(resolveModel(undefined, 'gpt-4o')).toEqual({
      model: 'gpt-4o',
      sender: 'GPT-4o',
    });
  });

  it('does not crash on an unknown slug', () => {
    expect(resolveModel('some-future-model', 'gpt-4o')).toEqual({
      model: 'some-future-model',
      sender: 'some-future-model',
    });
  });

  it('maps pro suffix label', () => {
    expect(resolveModel('gpt-5-4-pro', 'gpt-4o').sender).toBe('GPT-5.4 Pro');
  });

  it('maps instant suffix label', () => {
    expect(resolveModel('gpt-5-1-instant', 'gpt-4o').sender).toBe('GPT-5.1 Instant');
  });

  it('maps auto suffix label', () => {
    expect(resolveModel('gpt-5-4-auto-thinking', 'gpt-4o').sender).toBe('GPT-5.4 Auto Thinking');
  });

  it('maps t suffix as thinking', () => {
    expect(resolveModel('gpt-5-t-mini', 'gpt-4o').sender).toBe('GPT-5 Thinking mini');
  });

  it('covers all 25 real-world slugs from import data', () => {
    const cases = [
      ['gpt-4o', 'GPT-4o'],
      ['gpt-5-5-thinking', 'GPT-5.5 Thinking'],
      ['gpt-5', 'GPT-5'],
      ['gpt-5-thinking', 'GPT-5 Thinking'],
      ['gpt-4-1', 'GPT-4.1'],
      ['gpt-5-1-thinking', 'GPT-5.1 Thinking'],
      ['gpt-5-2', 'GPT-5.2'],
      ['gpt-5-4-thinking', 'GPT-5.4 Thinking'],
      ['gpt-5-1', 'GPT-5.1'],
      ['gpt-5-2-thinking', 'GPT-5.2 Thinking'],
      ['gpt-4o-mini', 'GPT-4o mini'],
      ['o3', 'o3'],
      ['o4-mini-high', 'o4-mini-high'],
      ['gpt-5-3', 'GPT-5.3'],
      ['gpt-5-6-thinking', 'GPT-5.6 Thinking'],
      ['gpt-5-5', 'GPT-5.5'],
      ['gpt-5-4-pro', 'GPT-5.4 Pro'],
      ['o4-mini', 'o4-mini'],
      ['gpt-5-t-mini', 'GPT-5 Thinking mini'],
      ['research', 'Deep Research'],
      ['gpt-5-4-auto-thinking', 'GPT-5.4 Auto Thinking'],
      ['gpt-5-1-instant', 'GPT-5.1 Instant'],
      ['o3-mini', 'o3-mini'],
      ['gpt-5-auto-thinking', 'GPT-5 Auto Thinking'],
      ['gpt-4-5', 'GPT-4.5'],
    ] as const;

    cases.forEach(([slug, expectedSender]) => {
      expect(resolveModel(slug, 'gpt-4o')).toEqual({
        model: slug,
        sender: expectedSender,
      });
    });
  });
});
