import type {
  CodeEnvironmentPermissionDecision,
  CodeEnvironmentUserConfigSchema,
  CodeEnvironmentUserSettings,
} from '../config';

export const CODE_APPROVAL_MODES = ['ask', 'acceptEdits', 'fullAccess'] as const;
export type CodeApprovalMode = (typeof CODE_APPROVAL_MODES)[number];

type CodePermissions = Required<NonNullable<CodeEnvironmentUserSettings['permissions']>>;

const MODE_PERMISSIONS: Record<CodeApprovalMode, CodePermissions> = {
  ask: { fileWrite: 'ask', commandExecution: 'ask' },
  acceptEdits: { fileWrite: 'allow', commandExecution: 'ask' },
  fullAccess: { fileWrite: 'allow', commandExecution: 'allow' },
};

export type CodeApprovalConstraints = {
  environment: 'attached' | 'managed';
  enabled?: boolean;
  allowedModes?: readonly CodeApprovalMode[];
  configSchema?: CodeEnvironmentUserConfigSchema;
  settings?: CodeEnvironmentUserSettings;
};

/** Omitted deployment configuration never grants unattended execution. */
export function getAllowedCodeApprovalModes({
  enabled,
  allowedModes,
  configSchema,
  settings,
  environment,
}: CodeApprovalConstraints): CodeApprovalMode[] {
  if (enabled === false) return [];
  const permitted = new Set(allowedModes ?? ['ask']);
  return CODE_APPROVAL_MODES.filter((mode) => {
    if (!permitted.has(mode)) return false;
    if (environment === 'managed') return true;
    for (const category of ['fileWrite', 'commandExecution'] as const) {
      if (MODE_PERMISSIONS[mode][category] !== 'allow') continue;
      const field = configSchema?.permissions?.[category];
      const configured = settings?.permissions?.[category];
      const effective =
        configured != null && field?.allowed.includes(configured) === true
          ? configured
          : (field?.default ?? 'ask');
      if (effective === 'deny' || field?.allowed.includes('allow') !== true) return false;
    }
    return true;
  });
}

export class CodeApprovalModeError extends Error {
  readonly code = 'CODE_APPROVAL_MODE_NOT_ALLOWED';

  constructor() {
    super('The selected code approval mode is not permitted by the current policy.');
    this.name = 'CodeApprovalModeError';
  }
}

/** Validate untrusted request state again at admission, including after policy changes. */
export function resolveCodeApprovalMode(
  requested: unknown,
  constraints: CodeApprovalConstraints,
): CodeApprovalMode | undefined {
  if (requested == null) return undefined;
  const allowed = getAllowedCodeApprovalModes(constraints);
  const selected = allowed.find((mode) => mode === requested);
  if (selected == null) throw new CodeApprovalModeError();
  return selected;
}

/** Apply a turn preference without modifying machine settings or overriding an existing deny. */
export function resolveCodePermissionDecision({
  mode,
  category,
  decision,
}: {
  mode?: CodeApprovalMode;
  category: keyof CodePermissions;
  decision: CodeEnvironmentPermissionDecision;
}): CodeEnvironmentPermissionDecision {
  if (mode == null || decision === 'deny') return decision;
  if (MODE_PERMISSIONS[mode] == null) throw new CodeApprovalModeError();
  return MODE_PERMISSIONS[mode][category];
}
