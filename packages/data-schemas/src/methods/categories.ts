import { defaultPromptCategories } from 'librechat-data-provider';
import logger from '~/config/winston';

export type CategoryOption = { label: string; value: string };

export function createCategoriesMethods(_mongoose: typeof import('mongoose')): {
  getCategories: () => Promise<CategoryOption[]>;
} {
  /**
   * Retrieves the categories.
   */
  async function getCategories(): Promise<CategoryOption[]> {
    try {
      return defaultPromptCategories.map((c) => ({ ...c }));
    } catch (error) {
      logger.error('Error getting categories', error);
      return [];
    }
  }

  return { getCategories };
}

export type CategoriesMethods = ReturnType<typeof createCategoriesMethods>;
