/** The list writer and avatar upload invalidator must always use the same tenant-scoped key. */
export function getAgentListAvatarRefreshKey(user: {
  id: string;
  tenantId?: string | null;
}): string {
  return `${user.id}:${user.tenantId ?? ''}:agents_avatar_refresh`;
}
