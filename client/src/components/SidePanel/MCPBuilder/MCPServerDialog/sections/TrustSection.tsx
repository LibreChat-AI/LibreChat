import { useMemo } from 'react';
import { Checkbox, Label } from '@librechat/client';
import { useFormContext, Controller } from 'react-hook-form';
import type { MCPServerFormData } from '../hooks/useMCPServerForm';
import { createConfigHtmlSanitizer } from '~/utils/configHtml';
import { useLocalize, useLocalizedConfig } from '~/hooks';
import { useGetStartupConfig } from '~/data-provider';

export default function TrustSection() {
  const localize = useLocalize();
  const { data: startupConfig } = useGetStartupConfig();
  const getLocalizedValue = useLocalizedConfig();
  const sanitize = useMemo(() => createConfigHtmlSanitizer(), []);
  const {
    control,
    formState: { errors },
  } = useFormContext<MCPServerFormData>();
  const trustCheckbox = startupConfig?.interface?.mcpServers?.trustCheckbox;
  const labelHTML = sanitize(getLocalizedValue(trustCheckbox?.label, localize('com_ui_trust_app')));
  const subLabelHTML = sanitize(
    getLocalizedValue(trustCheckbox?.subLabel, localize('com_agents_mcp_trust_subtext')),
  );

  return (
    <div className="bg-surface-secondary rounded-lg p-2">
      <div className="flex items-start gap-3">
        <Controller
          name="trust"
          control={control}
          rules={{ required: true }}
          render={({ field }) => (
            <Checkbox
              id="trust"
              checked={field.value}
              onCheckedChange={field.onChange}
              aria-labelledby="trust-label"
              aria-describedby={
                errors.trust ? 'trust-description trust-error' : 'trust-description'
              }
              aria-invalid={errors.trust ? 'true' : 'false'}
              aria-required="true"
              className="mt-0.5"
            />
          )}
        />
        <Label htmlFor="trust" className="flex cursor-pointer flex-col gap-0.5 text-sm">
          <span id="trust-label" className="text-text-primary font-medium">
            <span dangerouslySetInnerHTML={{ __html: labelHTML }} />{' '}
            <span aria-hidden="true" className="text-text-secondary">
              *
            </span>
          </span>
          <span id="trust-description" className="text-text-secondary text-xs font-normal">
            <span dangerouslySetInnerHTML={{ __html: subLabelHTML }} />
          </span>
        </Label>
      </div>
      {errors.trust && (
        <p id="trust-error" role="alert" className="text-text-destructive mt-2 text-xs">
          {localize('com_ui_field_required')}
        </p>
      )}
    </div>
  );
}
