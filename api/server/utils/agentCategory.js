const { logger } = require('@librechat/data-schemas');

/** Mirrors the hardcoded agent fallback in `data-schemas` (agent schema default and `createAgent`).
 * It must never be deactivated, or agents created without a category become unreachable from
 * every marketplace tab except "All". */
const FALLBACK_CATEGORY = 'general';

function normalizeValue(raw) {
  return (raw ?? '').toString().trim().toLowerCase();
}

function optionalString(raw) {
  return typeof raw === 'string' ? raw.trim() : undefined;
}

/**
 * Synchronizes agent categories with the database.
 * @param {Array|undefined} customCategoriesList - Custom categories from config. When `undefined`, custom categories are left untouched (only defaults are toggled). An explicit empty array opts in to deleting all existing custom categories.
 * @param {boolean} enableDefaultCategories - Whether default categories should be active.
 */
async function syncCategories(customCategoriesList, enableDefaultCategories) {
  const { getAllCategories, createCategory, updateCategory, deleteCategory } = require('~/models');
  logger.info('Syncing custom agent categories...');

  const dbCategories = await getAllCategories();
  logger.info(`Found ${dbCategories.length} categories in the database.`);

  logger.info(
    `${enableDefaultCategories ? 'Enabling' : 'Disabling'} default agent categories as per configuration.`,
  );
  if (!enableDefaultCategories) {
    logger.warn(
      `Keeping the '${FALLBACK_CATEGORY}' category active: it is the fallback assigned to agents created without a category. Declare it in the categories list to change its label or description.`,
    );
  }
  for (const cat of dbCategories.filter((c) => !c.custom)) {
    const isActive = cat.value === FALLBACK_CATEGORY ? true : enableDefaultCategories;
    logger.info(`${isActive ? 'Enabling' : 'Disabling'} category: ${cat.value}`);
    await updateCategory(cat.value, { isActive });
  }

  if (!Array.isArray(customCategoriesList)) {
    logger.info(
      'No custom categories list provided; leaving existing custom categories untouched.',
    );
    return;
  }

  const defaultCategoriesInDb = dbCategories.filter((cat) => !cat.custom);
  const initialOrder =
    defaultCategoriesInDb.reduce((max, cat) => Math.max(max, cat.order || 0), 0) + 1;
  logger.info(`Current order for new custom categories starts at ${initialOrder}.`);

  const preparedCategories = customCategoriesList.reduce((acc, cat, index) => {
    const normalizedValue = normalizeValue(cat?.value);
    if (!normalizedValue) {
      logger.warn(
        `Skipping invalid custom category entry at index ${index}: missing or empty value.`,
      );
      return acc;
    }
    acc.push({
      normalizedValue,
      rawValue: cat.value.toString().trim(),
      label: optionalString(cat.label) || undefined,
      description: optionalString(cat.description),
      order: initialOrder + acc.length,
    });
    return acc;
  }, []);

  const configuredValues = new Set(preparedCategories.map((c) => c.normalizedValue));
  const categoriesToDelete = dbCategories.filter(
    (cat) => cat.custom && !configuredValues.has(normalizeValue(cat.value)),
  );
  for (const cat of categoriesToDelete) {
    logger.info(`Deleting custom category not in config: ${cat.value}`);
    await deleteCategory(cat.value);
  }

  for (const prepared of preparedCategories) {
    const existing = dbCategories.find(
      (cat) => normalizeValue(cat.value) === prepared.normalizedValue,
    );

    /* Default categories keep `custom: false` when overridden, so the deletion pass above (which
     * only targets custom rows) can never remove them, and `ensureDefaultCategories` keeps
     * managing their localization keys. Only explicitly provided fields are applied — otherwise
     * re-declaring a default purely to reactivate it would clobber its `com_` label. */
    if (existing && !existing.custom) {
      const overrides = { isActive: true };
      if (prepared.label) {
        overrides.label = prepared.label;
      }
      if (prepared.description !== undefined) {
        overrides.description = prepared.description;
      }
      logger.info(`Overriding default category: ${existing.value}`);
      await updateCategory(existing.value, overrides);
      continue;
    }

    const formattedCategory = {
      value: prepared.normalizedValue,
      label: prepared.label || prepared.rawValue,
      description: prepared.description ?? '',
      isActive: true,
      custom: true,
      order: prepared.order,
    };

    if (existing) {
      logger.info(`Updating category: ${formattedCategory.value}`);
      await updateCategory(existing.value, formattedCategory);
    } else {
      logger.info(`Creating category: ${formattedCategory.value}`);
      await createCategory(formattedCategory);
    }
  }

  logger.info('Custom categories synchronized successfully.');
}

module.exports = {
  syncCategories,
};
