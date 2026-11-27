import type { TFile } from 'librechat-data-provider';
import { areMessageFilesEqual } from '~/utils';

const file = (overrides: Partial<TFile> = {}): TFile =>
  ({
    file_id: 'file-1',
    filename: 'sample.pdf',
    filepath: '/uploads/sample.pdf',
    type: 'application/pdf',
    bytes: 100,
    embedded: false,
    object: 'file',
    usage: 1,
    user: 'user-1',
    ...overrides,
  }) as TFile;

describe('areMessageFilesEqual', () => {
  it('detects when a raw message file is replaced by its hydrated file-map entry', () => {
    const rawFile = file({ filename: 'raw.pdf', preview: undefined });
    const hydratedFile = file({ filename: 'hydrated.pdf', preview: '/previews/sample.png' });

    expect(areMessageFilesEqual([rawFile], [hydratedFile])).toBe(false);
  });

  it('keeps equivalent file entries memoized when buildTree creates a new array', () => {
    const hydratedFile = file({ preview: '/previews/sample.png' });

    expect(areMessageFilesEqual([hydratedFile], [hydratedFile])).toBe(true);
  });

  it('detects attachment additions and removals', () => {
    const hydratedFile = file();

    expect(areMessageFilesEqual([], [hydratedFile])).toBe(false);
    expect(areMessageFilesEqual([hydratedFile], [])).toBe(false);
  });

  it('treats absent and empty file lists as equivalent', () => {
    expect(areMessageFilesEqual(undefined, [])).toBe(true);
  });
});
