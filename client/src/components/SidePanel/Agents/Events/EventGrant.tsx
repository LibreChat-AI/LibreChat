import type { MutableRefObject } from 'react';
import type { GrantCopy } from '~/components/MCP/GrantDialog';
import { useEventGrant, useEventGrantMutations } from '~/data-provider/Events';
import GrantDialog from '~/components/MCP/GrantDialog';

const copy: GrantCopy = {
  title: 'com_ui_events_grant_title',
  boundary: 'com_ui_events_grant_boundary',
  status: {
    missing: 'com_ui_events_grant_missing',
    changed: 'com_ui_events_grant_changed',
    unsupported: 'com_ui_events_grant_unsupported',
  },
  required: 'com_ui_events_grant_required',
  confirmed: 'com_ui_events_grant_confirmed',
};

/** What runs an event subscription starts may use, as its owner allows them. */
export default function EventGrant({
  canConfirm,
  id,
  name,
  onOpenChange,
  triggerRef,
}: {
  /** Without it the grant is shown and can be revoked, but not made or renewed. */
  canConfirm: boolean;
  id: string;
  name: string;
  onOpenChange: (open: boolean) => void;
  triggerRef: MutableRefObject<HTMLButtonElement | null>;
}) {
  const query = useEventGrant(id);
  const { confirm, revoke } = useEventGrantMutations(id);
  return (
    <GrantDialog
      canConfirm={canConfirm}
      longest
      source={{ query, confirm, revoke }}
      copy={copy}
      name={name}
      onOpenChange={onOpenChange}
      triggerRef={triggerRef}
    />
  );
}
