import { useAtom } from 'jotai';
import { createStorageAtom } from '~/store/jotai-utils';
import { useAuthContext } from '~/hooks/AuthContext';

interface WorkspacePreference {
  key: string;
  workspaceId: string;
}

const preferences = createStorageAtom<WorkspacePreference[]>('codeWorkspacePreferences', []);

function validEntries(saved: WorkspacePreference[]): WorkspacePreference[] {
  return Array.isArray(saved)
    ? saved.filter(
        (entry) => entry && typeof entry.key === 'string' && typeof entry.workspaceId === 'string',
      )
    : [];
}

/** Browser-local hints, never authorization or conversation bindings. */
export function useWorkspacePreferences(agentId?: string | null) {
  const { user } = useAuthContext();
  const [saved, setSaved] = useAtom(preferences);
  const keyFor = (environmentId: string, ownerAgentId = agentId) =>
    JSON.stringify([user?.tenantId ?? '', user?.id, ownerAgentId, environmentId]);
  const entries = validEntries(saved);
  return {
    get: (environmentId: string, ownerAgentId = agentId) =>
      user?.id && ownerAgentId
        ? entries.find((entry) => entry.key === keyFor(environmentId, ownerAgentId))?.workspaceId
        : undefined,
    remember: (environmentId: string, workspaceId: string, ownerAgentIds = [agentId]) => {
      if (!user?.id) return;
      const keys = ownerAgentIds
        .filter((ownerAgentId): ownerAgentId is string => Boolean(ownerAgentId))
        .map((ownerAgentId) => keyFor(environmentId, ownerAgentId));
      if (keys.length === 0) return;
      // Bound this browser's disposable MRU cache; evictions only restore the chooser.
      try {
        setSaved((current) =>
          [
            ...keys.map((key) => ({ key, workspaceId })),
            ...validEntries(current).filter((entry) => !keys.includes(entry.key)),
          ].slice(0, 100),
        );
      } catch {
        // Disabled or full browser storage must not prevent explicit workspace selection.
      }
    },
  };
}
