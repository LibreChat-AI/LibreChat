import type { Model } from 'mongoose';
import type { IAgentCategory } from '~/types';
import { tenantSafeBulkWrite } from '~/utils/tenantBulkWrite';

export function createAgentCategoryMethods(mongoose: typeof import('mongoose')): {
  getActiveCategories: () => Promise<IAgentCategory[]>;
  getCategoriesWithCounts: () => Promise<(IAgentCategory & { agentCount: number })[]>;
  createCategory: (categoryData: Partial<IAgentCategory>) => Promise<IAgentCategory>;
  getAllCategories: () => Promise<IAgentCategory[]>;
  ensureDefaultCategories: () => Promise<boolean>;
} {
  /**
   * Get all active categories sorted by order
   * @returns Array of active categories
   */
  async function getActiveCategories(): Promise<IAgentCategory[]> {
    const AgentCategory = mongoose.models.AgentCategory as Model<IAgentCategory>;
    return await AgentCategory.find({ isActive: true })
      .sort({ order: 1, label: 1 })
      .lean<IAgentCategory[]>();
  }

  /**
   * Get categories with agent counts
   * @returns Categories with agent counts
   */
  async function getCategoriesWithCounts(): Promise<(IAgentCategory & { agentCount: number })[]> {
    const Agent = mongoose.models.Agent;

    const [categoryCounts, categories] = await Promise.all([
      Agent.aggregate([
        { $match: { category: { $exists: true, $ne: null } } },
        { $group: { _id: '$category', count: { $sum: 1 } } },
      ]),
      getActiveCategories(),
    ]);

    const countMap = new Map(categoryCounts.map((c) => [c._id, c.count]));

    return categories.map((category) => ({
      ...category,
      agentCount: countMap.get(category.value) || (0 as number),
    })) as (IAgentCategory & { agentCount: number })[];
  }

  /**
   * Create a new category
   * @param categoryData - The category data to create
   * @returns The created category
   */
  async function createCategory(categoryData: Partial<IAgentCategory>): Promise<IAgentCategory> {
    const AgentCategory = mongoose.models.AgentCategory as Model<IAgentCategory>;
    const category = await AgentCategory.create(categoryData);
    return category.toObject() as IAgentCategory;
  }

  /**
   * Get all categories (active and inactive)
   * @returns Array of all categories
   */
  async function getAllCategories(): Promise<IAgentCategory[]> {
    const AgentCategory = mongoose.models.AgentCategory as Model<IAgentCategory>;
    return await AgentCategory.find({}).sort({ order: 1, label: 1 }).lean<IAgentCategory[]>();
  }

  /**
   * Ensure default categories exist and update them if they don't have localization keys
   * @returns Promise<boolean> - true if categories were created/updated, false if no changes
   */
  async function ensureDefaultCategories(): Promise<boolean> {
    const AgentCategory = mongoose.models.AgentCategory as Model<IAgentCategory>;

    const defaultCategories = [
      {
        value: 'general',
        label: 'com_agents_category_general',
        description: 'com_agents_category_general_description',
        order: 0,
      },
      {
        value: 'hr',
        label: 'com_agents_category_hr',
        description: 'com_agents_category_hr_description',
        order: 1,
      },
      {
        value: 'rd',
        label: 'com_agents_category_rd',
        description: 'com_agents_category_rd_description',
        order: 2,
      },
      {
        value: 'finance',
        label: 'com_agents_category_finance',
        description: 'com_agents_category_finance_description',
        order: 3,
      },
      {
        value: 'it',
        label: 'com_agents_category_it',
        description: 'com_agents_category_it_description',
        order: 4,
      },
      {
        value: 'sales',
        label: 'com_agents_category_sales',
        description: 'com_agents_category_sales_description',
        order: 5,
      },
      {
        value: 'aftersales',
        label: 'com_agents_category_aftersales',
        description: 'com_agents_category_aftersales_description',
        order: 6,
      },
    ];

    const existingCategories = await getAllCategories();
    const existingCategoryMap = new Map(existingCategories.map((cat) => [cat.value, cat]));

    const updates = [];
    let created = 0;

    for (const defaultCategory of defaultCategories) {
      const existingCategory = existingCategoryMap.get(defaultCategory.value);

      if (existingCategory) {
        const isNotCustom = !existingCategory.custom;
        const needsLocalization = !existingCategory.label.startsWith('com_');

        if (isNotCustom && needsLocalization) {
          updates.push({
            value: defaultCategory.value,
            label: defaultCategory.label,
            description: defaultCategory.description,
          });
        }
      } else {
        await createCategory({
          ...defaultCategory,
          isActive: true,
          custom: false,
        });
        created++;
      }
    }

    if (updates.length > 0) {
      const bulkOps = updates.map((update) => ({
        updateOne: {
          filter: { value: update.value, custom: { $ne: true } },
          update: {
            $set: {
              label: update.label,
              description: update.description,
            },
          },
        },
      }));

      await tenantSafeBulkWrite(AgentCategory, bulkOps, { ordered: false });
    }

    return updates.length > 0 || created > 0;
  }

  return {
    getActiveCategories,
    getCategoriesWithCounts,
    createCategory,
    getAllCategories,
    ensureDefaultCategories,
  };
}

export type AgentCategoryMethods = ReturnType<typeof createAgentCategoryMethods>;
