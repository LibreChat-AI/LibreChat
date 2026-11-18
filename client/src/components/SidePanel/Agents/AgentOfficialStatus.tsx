import { useId, useRef, useState } from 'react';
import { Label, Checkbox, OGDialog, OGDialogTemplate, useToastContext } from '@librechat/client';
import OfficialAgentIcon from '~/components/Agents/OfficialAgentIcon';
import { useSetAgentOfficialStatusMutation } from '~/data-provider';
import { useAgentOfficialStatus, useLocalize } from '~/hooks';

/**
 * Admin-only control for central official status. It saves on confirm rather than with the
 * form, because official status is not part of the agent's versioned configuration: an
 * unsaved form edit must not ride along, and a revert must not undo it.
 */
export default function AgentOfficialStatus({
  agentId,
  isOfficial,
}: {
  agentId: string;
  isOfficial: boolean;
}) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const { canManage, description } = useAgentOfficialStatus();
  const [pending, setPending] = useState<boolean | null>(null);
  const checkboxRef = useRef<HTMLButtonElement>(null);
  const labelId = useId();
  const hintId = useId();

  const mutation = useSetAgentOfficialStatusMutation({
    onSuccess: (result) => {
      showToast({
        message: localize(
          result.is_official
            ? 'com_ui_agent_marked_official_success'
            : 'com_ui_agent_official_status_removed',
        ),
        status: 'success',
      });
    },
    onError: () => {
      showToast({ message: localize('com_ui_agent_official_status_error'), status: 'error' });
    },
  });

  if (!canManage) {
    return null;
  }

  const markingOfficial = pending === true;
  const confirm = () => {
    if (pending == null) {
      return;
    }
    mutation.mutate({ agent_id: agentId, is_official: pending });
  };

  return (
    <div className="mb-3 flex flex-col">
      <Label
        variant="secondary"
        className="text-2xs mb-1 block font-medium tracking-wide uppercase"
      >
        {localize('com_ui_official_status')}
      </Label>
      <div className="flex items-start gap-2">
        <Checkbox
          ref={checkboxRef}
          id={labelId + '-checkbox'}
          aria-labelledby={labelId}
          aria-describedby={hintId}
          checked={isOfficial}
          disabled={mutation.isLoading}
          onCheckedChange={(checked) => setPending(checked === true)}
          className="mt-0.5"
        />
        <div className="flex min-w-0 flex-col gap-0.5">
          <label
            id={labelId}
            htmlFor={labelId + '-checkbox'}
            className="text-text-primary flex cursor-pointer items-center gap-1.5 text-sm"
          >
            {localize('com_ui_mark_official_agent')}
            {isOfficial && <OfficialAgentIcon static />}
          </label>
          <span id={hintId} className="text-text-secondary text-xs">
            {description}
          </span>
        </div>
      </div>
      <OGDialog
        open={pending != null}
        onOpenChange={(open) => !open && setPending(null)}
        triggerRef={checkboxRef}
      >
        <OGDialogTemplate
          title={localize(markingOfficial ? 'com_ui_mark_official_agent' : 'com_ui_remove_official_status_agent')}
          className="max-w-[28.125rem]"
          description={localize(
            markingOfficial ? 'com_ui_mark_official_agent_confirm' : 'com_ui_remove_official_status_agent_confirm',
          )}
          selection={{
            selectHandler: confirm,
            selectText: localize(markingOfficial ? 'com_ui_mark_official' : 'com_ui_remove_official_status'),
            isLoading: mutation.isLoading,
          }}
        />
      </OGDialog>
    </div>
  );
}
