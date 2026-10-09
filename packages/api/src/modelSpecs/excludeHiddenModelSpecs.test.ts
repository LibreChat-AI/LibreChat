import { EModelEndpoint } from 'librechat-data-provider';
import type { TModelSpec } from 'librechat-data-provider';
import { excludeHiddenModelSpecs } from './index';

const makeSpec = (name: string, showInMenu?: boolean): TModelSpec => ({
  name,
  label: name,
  ...(showInMenu === undefined ? {} : { showInMenu }),
  preset: {
    endpoint: EModelEndpoint.bedrock,
    model: 'claude-sonnet-4-6',
  },
});

describe('excludeHiddenModelSpecs', () => {
  it('drops specs marked showInMenu: false and keeps the rest', () => {
    const modelSpecs = {
      enforce: false,
      prioritize: true,
      list: [
        makeSpec('listed-default'),
        makeSpec('listed-explicit', true),
        makeSpec('hidden', false),
      ],
    };

    const result = excludeHiddenModelSpecs(modelSpecs);

    expect(result.list.map((s) => s.name)).toEqual(['listed-default', 'listed-explicit']);
  });

  it('treats an omitted showInMenu as listed (backwards compatible)', () => {
    const modelSpecs = { list: [makeSpec('no-flag')] };
    expect(excludeHiddenModelSpecs(modelSpecs).list).toHaveLength(1);
  });

  it('does not mutate the input', () => {
    const modelSpecs = { list: [makeSpec('keep'), makeSpec('hidden', false)] };
    excludeHiddenModelSpecs(modelSpecs);
    expect(modelSpecs.list).toHaveLength(2);
  });

  it('returns the config unchanged when there is no list', () => {
    expect(excludeHiddenModelSpecs(undefined)).toBeUndefined();
    expect(excludeHiddenModelSpecs(null)).toBeNull();
    const noList = { enforce: false, prioritize: true };
    expect(excludeHiddenModelSpecs(noList)).toBe(noList);
  });
});
