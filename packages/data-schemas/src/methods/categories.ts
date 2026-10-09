import logger from '~/config/winston';

const options = [
  { label: 'com_ui_idea', value: 'idea' },
  { label: 'com_ui_travel', value: 'travel' },
  { label: 'com_ui_teach_or_explain', value: 'teach_or_explain' },
  { label: 'com_ui_write', value: 'write' },
  { label: 'com_ui_shop', value: 'shop' },
  { label: 'com_ui_code', value: 'code' },
  { label: 'com_ui_misc', value: 'misc' },
  { label: 'com_ui_roleplay', value: 'roleplay' },
  { label: 'com_ui_finance', value: 'finance' },
] as const;

export type CategoryOption = { label: string; value: string };

export function createCategoriesMethods(_mongoose: typeof import('mongoose')): {
  getCategories: () => Promise<CategoryOption[]>;
} {
  /**
   * Retrieves the categories.
   */
  async function getCategories(): Promise<CategoryOption[]> {
    try {
      return [...options];
    } catch (error) {
      logger.error('Error getting categories', error);
      return [];
    }
  }

  return { getCategories };
}

export type CategoriesMethods = ReturnType<typeof createCategoriesMethods>;
