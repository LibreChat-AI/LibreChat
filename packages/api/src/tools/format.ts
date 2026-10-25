import { redactMessage } from '@librechat/data-schemas';
import { AuthType, EToolResources } from 'librechat-data-provider';
import type { TPlugin } from 'librechat-data-provider';

/**
 * Filters out duplicate plugins from the list of plugins.
 *
 * @param plugins The list of plugins to filter.
 * @returns The list of plugins with duplicates removed.
 */
export const filterUniquePlugins = (plugins?: TPlugin[]): TPlugin[] => {
  const seen = new Set();
  return (
    plugins?.filter((plugin) => {
      const duplicate = seen.has(plugin.pluginKey);
      seen.add(plugin.pluginKey);
      return !duplicate;
    }) || []
  );
};

/**
 * Determines if a plugin is authenticated by checking if all required authentication fields have non-empty values.
 * Supports alternate authentication fields, allowing validation against multiple possible environment variables.
 *
 * @param plugin The plugin object containing the authentication configuration.
 * @returns True if the plugin is authenticated for all required fields, false otherwise.
 */
export const checkPluginAuth = (plugin?: TPlugin): boolean => {
  if (!plugin?.authConfig || plugin.authConfig.length === 0) {
    return false;
  }

  return plugin.authConfig.every((authFieldObj) => {
    if (authFieldObj.optional === true) {
      return true;
    }

    const authFieldOptions = authFieldObj.authField.split('||');
    let isFieldAuthenticated = false;

    for (const fieldOption of authFieldOptions) {
      const envValue = process.env[fieldOption];
      if (envValue && envValue.trim() !== '' && envValue !== AuthType.USER_PROVIDED) {
        isFieldAuthenticated = true;
        break;
      }
    }

    return isFieldAuthenticated;
  });
};

/**
 * @param toolkits
 * @param toolName
 * @returns toolKey
 */
export function getToolkitKey({
  toolkits,
  toolName,
}: {
  toolkits: TPlugin[];
  toolName?: string;
}): string | undefined {
  let toolkitKey: string | undefined;
  if (!toolName) {
    return toolkitKey;
  }
  for (const toolkit of toolkits) {
    if (toolName.startsWith(EToolResources.image_edit)) {
      const splitMatches = toolkit.pluginKey.split('_');
      const suffix = splitMatches[splitMatches.length - 1];
      if (toolName.endsWith(suffix)) {
        toolkitKey = toolkit.pluginKey;
        break;
      }
    }
    if (toolName.startsWith(toolkit.pluginKey)) {
      toolkitKey = toolkit.pluginKey;
      break;
    }
  }
  return toolkitKey;
}

/** Error text a tool returns to the model, with credentials in request URLs and headers redacted. */
export function formatToolError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Error: ${redactMessage(message)}`;
}
