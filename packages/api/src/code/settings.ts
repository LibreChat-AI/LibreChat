import { codeEnvironmentUserSettingsSchema } from 'librechat-data-provider';
import type {
  CodeEnvironmentUserConfigSchema,
  CodeEnvironmentUserSettings,
} from 'librechat-data-provider';

export class CodeEnvironmentSettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodeEnvironmentSettingsValidationError';
  }
}

/** Validate a principal's settings against the exact fields and values exposed by admin policy. */
export function validateCodeEnvironmentUserSettings(
  configSchema: CodeEnvironmentUserConfigSchema | undefined,
  input: unknown,
): CodeEnvironmentUserSettings {
  const parsed = codeEnvironmentUserSettingsSchema.safeParse(input);
  if (!parsed.success) {
    throw new CodeEnvironmentSettingsValidationError('Code environment settings are invalid');
  }
  const permissions = parsed.data.permissions;
  if (permissions == null) {
    return parsed.data;
  }
  for (const permission of ['fileWrite', 'commandExecution'] as const) {
    const value = permissions[permission];
    if (value == null) continue;
    const field = configSchema?.permissions?.[permission];
    if (field == null || !field.allowed.includes(value)) {
      throw new CodeEnvironmentSettingsValidationError(
        `Code environment setting ${permission} is not configurable`,
      );
    }
  }
  return parsed.data;
}
