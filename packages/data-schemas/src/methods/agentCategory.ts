import type { Model, Types } from 'mongoose';
import type { IAgentCategory } from '~/types';
import { tenantSafeBulkWrite } from '~/utils/tenantBulkWrite';
import { runAsSystem } from '~/config/tenantContext';

export function createAgentCategoryMethods(mongoose: typeof import('mongoose')): {
  getActiveCategories: () => Promise<IAgentCategory[]>;
  getCategoriesWithCounts: () => Promise<(IAgentCategory & { agentCount: number })[]>;
  getValidCategoryValues: () => Promise<string[]>;
  seedCategories: (
    categories: Array<{
      value: string;
      label?: string;
      description?: string;
      order?: number;
      custom?: boolean;
    }>,
  ) => Promise<import('mongoose').mongo.BulkWriteResult>;
  findCategoryByValue: (value: string) => Promise<IAgentCategory | null>;
  createCategory: (categoryData: Partial<IAgentCategory>) => Promise<IAgentCategory>;
  updateCategory: (
    value: string,
    updateData: Partial<IAgentCategory>,
  ) => Promise<IAgentCategory | null>;
  deleteCategory: (value: string) => Promise<boolean>;
  findCategoryById: (id: string | Types.ObjectId) => Promise<IAgentCategory | null>;
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

    const categoryCounts = await Agent.aggregate([
      { $match: { category: { $exists: true, $ne: null } } },
      { $group: { _id: '$category', count: { $sum: 1 } } },
    ]);

    const countMap = new Map(categoryCounts.map((c) => [c._id, c.count]));
    const categories = await runAsSystem(() => getActiveCategories());

    return categories.map((category) => ({
      ...category,
      agentCount: countMap.get(category.value) || (0 as number),
    })) as (IAgentCategory & { agentCount: number })[];
  }

  /**
   * Get valid category values for Agent model validation
   * @returns Array of valid category values
   */
  async function getValidCategoryValues(): Promise<string[]> {
    const AgentCategory = mongoose.models.AgentCategory as Model<IAgentCategory>;
    return await AgentCategory.find({ isActive: true }).distinct('value').lean();
  }

  /**
   * Seed initial categories from existing constants
   * @param categories - Array of category data to seed
   * @returns Bulk write result
   */
  async function seedCategories(
    categories: Array<{
      value: string;
      label?: string;
      description?: string;
      order?: number;
      custom?: boolean;
    }>,
  ): Promise<import('mongoose').mongo.BulkWriteResult> {
    const AgentCategory = mongoose.models.AgentCategory as Model<IAgentCategory>;

    const operations = categories.map((category, index) => ({
      updateOne: {
        filter: { value: category.value },
        update: {
          $setOnInsert: {
            value: category.value,
            label: category.label || category.value,
            description: category.description || '',
            order: category.order || index,
            isActive: true,
            custom: category.custom || false,
          },
        },
        upsert: true,
      },
    }));

    return await tenantSafeBulkWrite(AgentCategory, operations);
  }

  /**
   * Find a category by value
   * @param value - The category value to search for
   * @returns The category document or null
   */
  async function findCategoryByValue(value: string): Promise<IAgentCategory | null> {
    const AgentCategory = mongoose.models.AgentCategory as Model<IAgentCategory>;
    return await AgentCategory.findOne({ value }).lean<IAgentCategory>();
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
   * Update a category by value
   * @param value - The category value to update
   * @param updateData - The data to update
   * @returns The updated category or null
   */
  async function updateCategory(
    value: string,
    updateData: Partial<IAgentCategory>,
  ): Promise<IAgentCategory | null> {
    const AgentCategory = mongoose.models.AgentCategory as Model<IAgentCategory>;
    return await AgentCategory.findOneAndUpdate(
      { value },
      { $set: updateData },
      { new: true, runValidators: true },
    ).lean<IAgentCategory>();
  }

  /**
   * Delete a category by value
   * @param value - The category value to delete
   * @returns Whether the deletion was successful
   */
  async function deleteCategory(value: string): Promise<boolean> {
    const AgentCategory = mongoose.models.AgentCategory as Model<IAgentCategory>;
    const result = await AgentCategory.deleteOne({ value });
    return result.deletedCount > 0;
  }

  /**
   * Find a category by ID
   * @param id - The category ID to search for
   * @returns The category document or null
   */
  async function findCategoryById(id: string | Types.ObjectId): Promise<IAgentCategory | null> {
    const AgentCategory = mongoose.models.AgentCategory as Model<IAgentCategory>;
    return await AgentCategory.findById(id).lean<IAgentCategory>();
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
    getValidCategoryValues,
    seedCategories,
    findCategoryByValue,
    createCategory,
    updateCategory,
    deleteCategory,
    findCategoryById,
    getAllCategories,
    ensureDefaultCategories,
  };
}

export type AgentCategoryMethods = ReturnType<typeof createAgentCategoryMethods>;
