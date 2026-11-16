import { useId, useRef, useState } from 'react';
import { Label, Checkbox, OGDialog, OGDialogTemplate, useToastContext } from '@librechat/client';
import { useSetAgentCertificationMutation } from '~/data-provider';
import CertifiedIcon from '~/components/Agents/CertifiedIcon';
import { useAgentCertification, useLocalize } from '~/hooks';

/**
 * Admin-only control for central certification. It saves on confirm rather than with the
 * form, because certification is not part of the agent's versioned configuration: an
 * unsaved form edit must not ride along, and a revert must not undo it.
 */
export default function AgentCertification({
  agentId,
  isCertified,
}: {
  agentId: string;
  isCertified: boolean;
}) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const { canManage, description } = useAgentCertification();
  const [pending, setPending] = useState<boolean | null>(null);
  const checkboxRef = useRef<HTMLButtonElement>(null);
  const labelId = useId();
  const hintId = useId();

  const mutation = useSetAgentCertificationMutation({
    onSuccess: (result) => {
      showToast({
        message: localize(
          result.is_certified
            ? 'com_ui_agent_certified_success'
            : 'com_ui_agent_uncertified_success',
        ),
        status: 'success',
      });
    },
    onError: () => {
      showToast({ message: localize('com_ui_agent_certification_error'), status: 'error' });
    },
  });

  if (!canManage) {
    return null;
  }

  const certifying = pending === true;
  const confirm = () => {
    if (pending == null) {
      return;
    }
    mutation.mutate({ agent_id: agentId, is_certified: pending });
  };

  return (
    <div className="mb-3 flex flex-col">
      <Label
        variant="secondary"
        className="text-2xs mb-1 block font-medium tracking-wide uppercase"
      >
        {localize('com_ui_certification')}
      </Label>
      <div className="flex items-start gap-2">
        <Checkbox
          ref={checkboxRef}
          id={labelId + '-checkbox'}
          aria-labelledby={labelId}
          aria-describedby={hintId}
          checked={isCertified}
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
            {localize('com_ui_certify_agent')}
            {isCertified && <CertifiedIcon static />}
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
          title={localize(certifying ? 'com_ui_certify_agent' : 'com_ui_uncertify_agent')}
          className="max-w-[28.125rem]"
          description={localize(
            certifying ? 'com_ui_certify_agent_confirm' : 'com_ui_uncertify_agent_confirm',
          )}
          selection={{
            selectHandler: confirm,
            selectText: localize(certifying ? 'com_ui_certify' : 'com_ui_uncertify'),
            isLoading: mutation.isLoading,
          }}
        />
      </OGDialog>
    </div>
  );
}
