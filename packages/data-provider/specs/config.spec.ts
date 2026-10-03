import { promptsConfigSchema, defaultPromptCategories, configSchema } from '../src/config';

const parse = (categories: unknown) => promptsConfigSchema.safeParse({ categories });
const entries = (n: number) => Array.from({ length: n }, (_, i) => ({ value: `cat${i}` }));

describe('prompts.categories', () => {
  it('parses a valid full config', () => {
    const result = parse({
      enableDefaultCategories: false,
      allowCustom: true,
      list: [{ value: 'legal', label: 'Legal', icon: 'settings', color: 'series-3' }],
    });
    expect(result.success).toBe(true);
  });

  it('parses when the section is missing', () => {
    expect(promptsConfigSchema.safeParse(undefined).success).toBe(true);
    expect(configSchema.safeParse({ version: '1.0.0' }).success).toBe(true);
  });

  it('rejects duplicate values differing by case or whitespace at the duplicate entry', () => {
    const result = parse({ list: [{ value: 'Legal' }, { value: 'other' }, { value: ' legal ' }] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(['categories', 'list', 2, 'value']);
    }
  });

  it('rejects values with the reserved system prefix', () => {
    expect(parse({ list: [{ value: 'sys__x' }] }).success).toBe(false);
  });

  it('rejects empty values', () => {
    expect(parse({ list: [{ value: '' }] }).success).toBe(false);
    expect(parse({ list: [{ value: '   ' }] }).success).toBe(false);
  });

  it('rejects control characters', () => {
    expect(parse({ list: [{ value: 'a\u0007b' }] }).success).toBe(false);
  });

  it('rejects a 101-character value and accepts 100', () => {
    expect(parse({ list: [{ value: 'a'.repeat(101) }] }).success).toBe(false);
    expect(parse({ list: [{ value: 'a'.repeat(100) }] }).success).toBe(true);
  });

  it('rejects more than 50 entries and accepts 50', () => {
    expect(parse({ list: entries(51) }).success).toBe(false);
    expect(parse({ list: entries(50) }).success).toBe(true);
  });

  it('rejects an unknown icon', () => {
    expect(parse({ list: [{ value: 'a', icon: 'rocket' }] }).success).toBe(false);
  });

  it('rejects an unknown color', () => {
    expect(parse({ list: [{ value: 'a', color: 'series-9' }] }).success).toBe(false);
  });

  it('defaultPromptCategories matches the built-in categories', () => {
    expect(defaultPromptCategories).toEqual([
      { label: 'com_ui_idea', value: 'idea' },
      { label: 'com_ui_travel', value: 'travel' },
      { label: 'com_ui_teach_or_explain', value: 'teach_or_explain' },
      { label: 'com_ui_write', value: 'write' },
      { label: 'com_ui_shop', value: 'shop' },
      { label: 'com_ui_code', value: 'code' },
      { label: 'com_ui_misc', value: 'misc' },
      { label: 'com_ui_roleplay', value: 'roleplay' },
      { label: 'com_ui_finance', value: 'finance' },
    ]);
  });
});
