import { configSchema } from '../src/config';

describe('configSchema — interface.marketplace.categories', () => {
  const withCategories = (categories: unknown) => ({
    version: '1.2.8',
    interface: { marketplace: { use: true, categories } },
  });

  it('accepts a valid categories block with an ordered list', () => {
    const result = configSchema.safeParse(
      withCategories({
        enableDefaultCategories: true,
        list: [
          { value: 'Education', description: 'Educational agents.' },
          { value: 'Productivity' },
        ],
      }),
    );
    expect(result.success).toBe(true);
  });

  it('accepts an optional `label` used as a translation key', () => {
    const result = configSchema.safeParse(
      withCategories({
        list: [
          { value: 'education', label: 'com_agents_category_education' },
          { value: 'aftersales', label: 'Customer Success' },
        ],
      }),
    );
    expect(result.success).toBe(true);
  });

  it('rejects a non-string `label`', () => {
    const result = configSchema.safeParse(
      withCategories({ list: [{ value: 'education', label: 42 }] }),
    );
    expect(result.success).toBe(false);
  });

  it('accepts categories with only enableDefaultCategories (no list)', () => {
    const result = configSchema.safeParse(withCategories({ enableDefaultCategories: false }));
    expect(result.success).toBe(true);
  });

  it('rejects a list item missing the required `value`', () => {
    const result = configSchema.safeParse(
      withCategories({ list: [{ description: 'no value here' }] }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects a non-array `list`', () => {
    const result = configSchema.safeParse(withCategories({ list: 'Education' }));
    expect(result.success).toBe(false);
  });

  it('rejects a non-boolean `enableDefaultCategories`', () => {
    const result = configSchema.safeParse(withCategories({ enableDefaultCategories: 'yes' }));
    expect(result.success).toBe(false);
  });
});
