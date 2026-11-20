import type { MutableRefObject } from 'react';
import type { GrantCopy } from '~/components/MCP/GrantDialog';
import {
  useScheduleMCPConsent,
  useScheduleMCPConsentMutations,
} from '~/data-provider/Schedules/consent';
import GrantDialog from '~/components/MCP/GrantDialog';

const copy: GrantCopy = {
  title: 'com_ui_schedule_consent_title',
  boundary: 'com_ui_schedule_consent_boundary',
};

/** The grant a schedule's owner makes for it. */
export default function Consent({
  canConfirm = true,
  id,
  name,
  onOpenChange,
  triggerRef,
}: {
  canConfirm?: boolean;
  id: string;
  name: string;
  onOpenChange: (open: boolean) => void;
  triggerRef: MutableRefObject<HTMLButtonElement | null>;
}) {
  const query = useScheduleMCPConsent(id);
  const { confirm, revoke } = useScheduleMCPConsentMutations(id);
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
