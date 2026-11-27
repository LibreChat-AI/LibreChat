import type { MCPOptions } from 'librechat-data-provider';
import { MCPApiKeyReentryRequiredError } from '~/mcp/errors';
import { getChangedApiKeyBindingFields } from './binding';

/** Requires a replacement key before a stored admin credential can cross request boundaries. */
export function requireApiKeyReentryForRebinding(
  existingConfig: MCPOptions,
  updatedConfig: MCPOptions,
): void {
  const changedFields = getChangedApiKeyBindingFields(existingConfig, updatedConfig);
  if (changedFields.length > 0) {
    throw new MCPApiKeyReentryRequiredError(changedFields);
  }
}
