import { logger } from '@librechat/data-schemas';
import { AuthType, EToolResources } from 'librechat-data-provider';
import type { TPlugin } from 'librechat-data-provider';
import { getSafeErrorMetadata } from '~/utils/errors';

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

/** Tool error text for any failure the tool did not word for the model itself. */
export const TOOL_ERROR_FALLBACK = 'The tool request failed.';

/**
 * A tool failure whose message the tool wrote for the model: input guidance such as an unknown
 * city or a malformed date. It is the only exception text a tool result carries; provider,
 * network and runtime messages stay in the logs.
 */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolInputError';
    Object.setPrototypeOf(this, ToolInputError.prototype);
  }
}

/** The approved text for a tool failure: a `ToolInputError` message, otherwise the fallback. */
export function getToolErrorText(error: unknown): string {
  return error instanceof ToolInputError ? error.message : TOOL_ERROR_FALLBACK;
}

/**
 * Error text a tool returns to the model. Only a `ToolInputError` keeps its message; any other
 * failure becomes the stable fallback, and its status (never its text) is logged under `source`.
 */
export function formatToolError(error: unknown, source = 'tool'): string {
  if (!(error instanceof ToolInputError)) {
    logger.warn(`[${source}] Tool request failed`, getSafeErrorMetadata(error));
  }
  return `Error: ${getToolErrorText(error)}`;
}

/** Approved wording for an upstream HTTP status, keyed by the status class a model can act on. */
function describeToolHttpStatus(status: number): string {
  if (status === 401 || status === 403) {
    return 'rejected the configured credentials';
  }
  if (status === 404) {
    return 'found no result for this request';
  }
  if (status === 429) {
    return 'is rate limiting requests; try again later';
  }
  if (status >= 500) {
    return 'is unavailable; try again later';
  }
  if (status >= 400) {
    return 'rejected the request parameters; check them and try again';
  }
  return `failed with status ${status}`;
}

/**
 * Error text for a tool whose upstream service answered with a failing HTTP status. The response
 * body is provider text, so only the status reaches the model; `overrides` lets a tool word a
 * status its service documents specifically.
 */
export function formatToolHttpError(
  service: string,
  status: number,
  overrides?: Readonly<Partial<Record<number, string>>>,
): string {
  logger.warn(`[${service}] Tool request failed`, { status });
  const override = overrides?.[status];
  if (override != null) {
    return `Error: ${override}`;
  }
  return `Error: ${service} ${describeToolHttpStatus(status)} (status ${status}).`;
}
