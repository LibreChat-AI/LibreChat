export const STATEFUL_CODE_ENVIRONMENTS = ['user', 'agent-user', 'conversation'] as const;
export type StatefulCodeEnvironment = (typeof STATEFUL_CODE_ENVIRONMENTS)[number];

/** Resolve a deployment allowlist in stable UI order. An omitted value preserves
 * the backward-compatible behavior where every environment is available. */
export function resolveAllowedStatefulCodeEnvironments(
  configured?: readonly StatefulCodeEnvironment[] | null,
): StatefulCodeEnvironment[] {
  if (configured == null) {
    return [...STATEFUL_CODE_ENVIRONMENTS];
  }

  const configuredSet = new Set(configured);
  return STATEFUL_CODE_ENVIRONMENTS.filter((environment) => configuredSet.has(environment));
}

/** Keep an allowed preference, otherwise select the first deployment-allowed scope. */
export function resolveStatefulCodeEnvironment(
  preferred: StatefulCodeEnvironment | null | undefined,
  configured?: readonly StatefulCodeEnvironment[] | null,
): StatefulCodeEnvironment | undefined {
  const allowed = resolveAllowedStatefulCodeEnvironments(configured);
  return preferred != null && allowed.includes(preferred) ? preferred : allowed[0];
}
