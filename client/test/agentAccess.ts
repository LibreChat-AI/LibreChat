import { createElement } from 'react';
import { SystemRoles, Permissions, PermissionTypes } from 'librechat-data-provider';
import type { ComponentType, ReactNode } from 'react';
import type { TAuthContext } from '~/common';
import { AuthContext } from '~/hooks/AuthContext';

/** Auth context for a USER whose role grants (or withholds) AGENTS.USE. */
export function agentAccessAuth(canUseAgents = true): TAuthContext {
  return {
    isAuthenticated: true,
    user: { id: 'user-1', role: SystemRoles.USER },
    roles: {
      [SystemRoles.USER]: {
        name: SystemRoles.USER,
        permissions: { [PermissionTypes.AGENTS]: { [Permissions.USE]: canUseAgents } },
      },
    },
  } as unknown as TAuthContext;
}

/** Wraps `Inner` in an auth context, since the agent list query is gated on AGENTS.USE. */
export function withAgentAccess(
  Inner: ComponentType<{ children: ReactNode }>,
  canUseAgents = true,
): ComponentType<{ children: ReactNode }> {
  const auth = agentAccessAuth(canUseAgents);
  return function AgentAccessWrapper({ children }: { children: ReactNode }) {
    return createElement(
      AuthContext.Provider,
      { value: auth },
      createElement(Inner, null, children),
    );
  };
}
