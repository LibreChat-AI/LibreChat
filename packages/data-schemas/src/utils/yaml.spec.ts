import { stripYamlTrailingComment } from './yaml';

describe('stripYamlTrailingComment', () => {
  it('strips comments separated from an unquoted scalar by whitespace', () => {
    expect(stripYamlTrailingComment('true   # enabled by default')).toBe('true');
    expect(stripYamlTrailingComment('false\t# disabled')).toBe('false');
    expect(stripYamlTrailingComment('hashtag#value')).toBe('hashtag#value');
    expect(stripYamlTrailingComment('  # comment only')).toBe('');
  });

  it('handles long comment-free whitespace runs in linear time', () => {
    const value = `a${' '.repeat(100_000)}b`;
    expect(stripYamlTrailingComment(value)).toBe(value);
  }, 1_000);
});
