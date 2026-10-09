import { Permissions, PermissionTypes } from 'librechat-data-provider';
import useHasAccess from './useHasAccess';

/**
 * The inline memory tools (`set_memory`/`delete_memory`) mutate memory, so the
 * memory badge and agent-builder toggle gate on the full write permission set
 * (USE + CREATE + UPDATE) — matching the backend `memoryAvailable` gate and the
 * runtime tool loader. A read-only-memory role therefore never sees an enabled
 * Memory control that the backend would refuse to wire up.
 */
export default function useHasMemoryAccess(): boolean {
  const canUse = useHasAccess({
    permissionType: PermissionTypes.MEMORIES,
    permission: Permissions.USE,
  });
  const canCreate = useHasAccess({
    permissionType: PermissionTypes.MEMORIES,
    permission: Permissions.CREATE,
  });
  const canUpdate = useHasAccess({
    permissionType: PermissionTypes.MEMORIES,
    permission: Permissions.UPDATE,
  });
  return canUse && canCreate && canUpdate;
}
