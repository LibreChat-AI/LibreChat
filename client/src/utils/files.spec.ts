import type { ExtendedFile } from '~/common';
import { hasIncompleteFiles, normalizeExportFilename } from './files';

describe('hasIncompleteFiles', () => {
  const createFile = (file_id: string, progress: number): ExtendedFile => ({
    file_id,
    progress,
    size: 1,
  });

  it('returns true while any attachment is still uploading', () => {
    const files = new Map([
      ['complete', createFile('complete', 1)],
      ['uploading', createFile('uploading', 0.9)],
    ]);

    expect(hasIncompleteFiles(files)).toBe(true);
  });

  it('returns false as soon as every attachment is complete', () => {
    const files = new Map([
      ['first', createFile('first', 1)],
      ['second', createFile('second', 1)],
    ]);

    expect(hasIncompleteFiles(files)).toBe(false);
  });
});

describe('normalizeExportFilename', () => {
  it('replaces every whitespace run with a single underscore', () => {
    expect(normalizeExportFilename('Word1 Word2 Word3')).toBe('Word1_Word2_Word3');
  });

  it('collapses consecutive whitespace into one underscore', () => {
    expect(normalizeExportFilename('Word1  Word2\tWord3')).toBe('Word1_Word2_Word3');
  });

  it('leaves filenames without whitespace unchanged', () => {
    expect(normalizeExportFilename('single-word_name')).toBe('single-word_name');
  });

  it('handles an empty string', () => {
    expect(normalizeExportFilename('')).toBe('');
  });

  it('never leaves whitespace, so downstream whitespace-based formatters are no-ops', () => {
    const inputs = ['Word1 Word2 Word3', ' leading', 'trailing ', 'tab\there', 'a  b   c'];
    for (const input of inputs) {
      expect(normalizeExportFilename(input)).not.toMatch(/\s/);
    }
  });
});
