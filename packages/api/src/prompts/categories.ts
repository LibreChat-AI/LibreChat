import { logger } from '@librechat/data-schemas';
import { defaultPromptCategories } from 'librechat-data-provider';
import type { TCategory, TPromptsConfig } from 'librechat-data-provider';
import type { Response } from 'express';
import type { ServerRequest } from '~/types';

type CategoryEntry = {
  value: string;
  label?: string;
  icon?: TCategory['icon'];
  color?: TCategory['color'];
};

type CategoryHandlerDeps<TIds> = {
  getPromptGroupAccessContext: (params: {
    userId: string;
    role?: string;
  }) => Promise<{ accessibleIds: TIds }>;
  getDistinctPromptGroupCategories: (accessibleIds: TIds) => Promise<string[]>;
};

const normalize = (value: string): string => value.trim().toLowerCase();

const fromEntry = ({ value, label, icon, color }: CategoryEntry): TCategory => ({
  value,
  label: label || value,
  ...(icon && { icon }),
  ...(color && { color }),
});

export function resolvePromptCategories(
  config: TPromptsConfig | undefined,
  customValues: string[],
): TCategory[] {
  const categories = config?.categories;
  const entries: CategoryEntry[] = (categories?.list ?? []).map((entry) => ({
    ...entry,
    value: entry.value.trim(),
    label: entry.label?.trim(),
  }));
  const result: TCategory[] =
    categories?.enableDefaultCategories === false
      ? []
      : defaultPromptCategories.map((category) => ({ ...category }));
  const builtinCount = result.length;

  for (const entry of entries) {
    const key = normalize(entry.value);
    const index = result.findIndex(
      (category, i) => i < builtinCount && normalize(category.value) === key,
    );
    if (index === -1) {
      result.push(fromEntry(entry));
      continue;
    }
    const { label, icon, color } = entry;
    result[index] = {
      ...result[index],
      ...(label && { label }),
      ...(icon && { icon }),
      ...(color && { color }),
    };
  }

  if (categories?.allowCustom !== true) {
    return result;
  }

  const seen = new Set(result.map((c) => c.value));
  for (const value of customValues) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push({ value, label: value, custom: true });
  }
  return result;
}

export function createGetPromptCategoriesHandler<TIds>(
  deps: CategoryHandlerDeps<TIds>,
): (req: ServerRequest, res: Response) => Promise<void> {
  return async (req: ServerRequest, res: Response): Promise<void> => {
    try {
      const config = req.config?.prompts;
      let customValues: string[] = [];
      if (config?.categories?.allowCustom === true) {
        const { accessibleIds } = await deps.getPromptGroupAccessContext({
          userId: req.user?.id ?? '',
          role: req.user?.role,
        });
        customValues = await deps.getDistinctPromptGroupCategories(accessibleIds);
      }
      res.status(200).send(resolvePromptCategories(config, customValues));
    } catch (error) {
      logger.error('[getPromptCategories] Failed to retrieve categories', error);
      res.status(500).send({ message: 'Failed to retrieve categories' });
    }
  };
}

export function getPromptCategoriesStartupConfig(
  appConfig: { prompts?: TPromptsConfig } | undefined,
): { allowCustom: boolean } {
  return { allowCustom: appConfig?.prompts?.categories?.allowCustom === true };
}
