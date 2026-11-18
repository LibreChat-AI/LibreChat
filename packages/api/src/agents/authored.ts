import { SKILL_NAME_PATTERN } from 'librechat-data-provider';
import type { EventHandler, SubagentExecutionContext } from '@librechat/agents';

/** Server-owned identity, not skill content or permission grants. */
export interface AuthoredSkillBinding {
  agentId: string;
  executionId?: string;
  name: string;
  id: string;
  primed: boolean;
}

type Scope = Pick<AuthoredSkillBinding, 'agentId' | 'executionId'>;

const states = new WeakMap<EventHandler, AuthoredSkillState>();

export function captureAuthoredSkills(handler?: EventHandler): AuthoredSkillBinding[] {
  return handler == null ? [] : (states.get(handler)?.snapshot() ?? []);
}

export function restoreAuthoredSkills(
  handler: EventHandler | undefined,
  bindings: readonly AuthoredSkillBinding[] | undefined,
): void {
  if (handler != null && bindings != null) states.get(handler)?.restore(bindings);
}

/** One handler belongs to one authenticated generation segment. */
export class AuthoredSkillState {
  private readonly bindings = new Map<string, AuthoredSkillBinding>();
  private readonly pending = new Map<string, AuthoredSkillBinding>();

  bind(handler: EventHandler): void {
    states.set(handler, this);
  }

  scope(agentId?: string, context?: SubagentExecutionContext): Scope {
    return {
      agentId: agentId ?? '',
      executionId: context?.ancestry[context.ancestry.length - 1]?.subagentRunId,
    };
  }

  private key(scope: Scope, name?: string): string {
    return JSON.stringify([scope.agentId, scope.executionId ?? null, name ?? null]);
  }

  record(scope: Scope, binding: Pick<AuthoredSkillBinding, 'name' | 'id' | 'primed'>): void {
    const key = this.key(scope, binding.name);
    const previous = this.bindings.get(key);
    this.bindings.set(key, {
      ...scope,
      ...binding,
      primed: binding.primed || (previous?.id === binding.id && previous.primed === true),
    });
  }

  snapshot(): AuthoredSkillBinding[] {
    return [...this.bindings.values()].map((binding) => ({ ...binding }));
  }

  restore(bindings: readonly AuthoredSkillBinding[]): void {
    for (const binding of bindings) {
      if (
        typeof binding.agentId !== 'string' ||
        (binding.executionId != null && typeof binding.executionId !== 'string') ||
        typeof binding.name !== 'string' ||
        !SKILL_NAME_PATTERN.test(binding.name) ||
        typeof binding.id !== 'string' ||
        !/^[a-f0-9]{24}$/i.test(binding.id)
      ) {
        continue;
      }
      const copy = { ...binding, primed: binding.primed === true };
      const key = this.key(copy, copy.name);
      this.bindings.set(key, copy);
      this.pending.set(key, copy);
    }
  }

  get hasPending(): boolean {
    return this.pending.size > 0;
  }

  confirm(scope: Scope, name: string): void {
    this.pending.delete(this.key(scope, name));
  }

  take(scope: Scope, names: ReadonlySet<string>): AuthoredSkillBinding[] {
    const bindings: AuthoredSkillBinding[] = [];
    for (const name of names) {
      const key = this.key(scope, name);
      const binding = this.pending.get(key);
      if (binding == null) continue;
      bindings.push(binding);
    }
    return bindings;
  }
}
