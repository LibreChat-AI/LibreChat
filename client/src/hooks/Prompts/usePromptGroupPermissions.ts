import { ResourceType } from 'librechat-data-provider';
import type { TPromptGroup } from 'librechat-data-provider';
import useResourcePermissions from '~/hooks/useResourcePermissions';
import { getPromptGroupPermissions } from '~/utils/promptGroups';

export interface PromptGroupPermissions {
  /** Permission query is still resolving */
  isLoading: boolean;
  /** Group is externally managed (e.g. Langfuse) and read-only locally */
  isExternal: boolean;
  /** Caller can view the group */
  canView: boolean;
  /** Caller can modify the group's prompts, name, category, description or command */
  canEdit: boolean;
  /** Caller can delete the group entirely */
  canDelete: boolean;
}

/**
 * Derives per-prompt-group permissions from the group's ACL bits, used by
 * the prompt form and related UI. `getPromptGroupPermissions` holds the
 * rule (an external group, e.g. Langfuse, is always read-only locally
 * regardless of ACL bits); list rows call that helper directly rather than
 * going through this hook, since they already have `permissionBits` from
 * their own `useResourcePermissions` call.
 */
export default function usePromptGroupPermissions(
  group: TPromptGroup | undefined,
): PromptGroupPermissions {
  const { permissionBits, isLoading } = useResourcePermissions(
    ResourceType.PROMPTGROUP,
    group?._id ?? '',
  );

  return {
    isLoading,
    ...getPromptGroupPermissions(group, permissionBits),
  };
}
