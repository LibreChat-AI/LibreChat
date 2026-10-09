import type { FiltersConfig } from 'librechat-data-provider';
import { ContentFilterError } from '../middleware/contentFilter';
import { assertSkillFileContentAllowed } from './protection';
import { UninspectableFileError } from '../protection/files';

describe('skill file content protection', () => {
  it('applies skill and canonical file projections to the same text buffer', () => {
    const filters: FiltersConfig = {
      skills: {
        pii: {
          fields: ['file_text'],
          starterPatterns: [],
          customPatterns: [{ id: 'private', label: 'private text', regex: 'PRIVATE-TEXT' }],
        },
      },
    };

    expect(() =>
      assertSkillFileContentAllowed(filters, {
        buffer: Buffer.from('PRIVATE-TEXT'),
        originalName: 'notes.md',
        relativePath: 'references/notes.md',
      }),
    ).toThrow(ContentFilterError);
  });

  it('fails closed for one binary classification shared by upload and runtime paths', () => {
    const filters: FiltersConfig = {
      files: {
        pii: {
          fields: ['content'],
          starterPatterns: [],
          customPatterns: [],
          uninspectable: 'block',
        },
      },
    };

    expect(() =>
      assertSkillFileContentAllowed(filters, {
        buffer: Buffer.from([0, 255, 0]),
        originalName: 'asset.bin',
        relativePath: 'assets/asset.bin',
      }),
    ).toThrow(UninspectableFileError);
  });

  it('does not decode file bytes when only filename policy is active', () => {
    const filters: FiltersConfig = {
      files: {
        pii: {
          fields: ['name'],
          starterPatterns: [],
          customPatterns: [{ id: 'private', label: 'private name', regex: 'PRIVATE-NAME' }],
        },
      },
    };
    const buffer = Buffer.from('contents do not need inspection');
    const toString = jest.spyOn(buffer, 'toString');

    expect(() =>
      assertSkillFileContentAllowed(filters, {
        buffer,
        originalName: 'safe.md',
        relativePath: 'references/safe.md',
      }),
    ).not.toThrow();
    expect(toString).not.toHaveBeenCalled();
  });
});
