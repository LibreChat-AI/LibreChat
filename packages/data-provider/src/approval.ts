import type { TToolApprovalPolicy } from './config';

/** Presentation-only constraints. Execution remains owned by the SDK policy hook. */
export function getToolApprovalConstraint(
  policy: TToolApprovalPolicy,
  toolName: string,
): 'ask' | 'deny' | undefined {
  if (policy?.enabled !== true) return undefined;
  const matches = (patterns?: string[]) =>
    patterns?.some((pattern) => {
      const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp('^' + escaped.replace(/\*/g, '.*') + '$').test(toolName);
    }) === true;
  if (matches(policy.deny)) return 'deny';
  if (matches(policy.ask)) return 'ask';
  if (matches(policy.allow)) return undefined;
  if (policy.mode === 'dontAsk') return 'deny';
  if (policy.mode !== 'bypass') return 'ask';
  return undefined;
}
