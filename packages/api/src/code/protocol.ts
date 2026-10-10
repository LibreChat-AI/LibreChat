import {
  CODE_ENVIRONMENT_DECISION_VERSION,
  isCodeEnvironmentSelectionAllowed,
} from 'librechat-data-provider';

/**
 * Resolves the deployment-wide browser protocol gate. Unset or blank advertises the supported
 * version, so per-chat machine choice works without a second opt-in. Any other value than the
 * exact version — `0` to opt out, or an older or future wire shape — keeps the legacy-safe path.
 */
export function resolveCodeEnvironmentDecisionVersion(
  configuredVersion?: string,
): typeof CODE_ENVIRONMENT_DECISION_VERSION | undefined {
  const version = configuredVersion?.trim() ?? '';
  return version === '' || version === String(CODE_ENVIRONMENT_DECISION_VERSION)
    ? CODE_ENVIRONMENT_DECISION_VERSION
    : undefined;
}

/**
 * Per-chat machine choice is recorded through the decision protocol, so a deployment that turns
 * the protocol off (`CODE_ENVIRONMENT_DECISION_VERSION=0`) turns machine choice off as well, for
 * both what the server advertises and what it routes.
 */
export function isCodeEnvironmentSelectionEnabled(
  allowEnvironmentSelection?: boolean | null,
  configuredDecisionVersion: string | undefined = process.env.CODE_ENVIRONMENT_DECISION_VERSION,
): boolean {
  return (
    isCodeEnvironmentSelectionAllowed(allowEnvironmentSelection) &&
    resolveCodeEnvironmentDecisionVersion(configuredDecisionVersion) != null
  );
}
