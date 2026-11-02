import { useFormContext } from 'react-hook-form';
import { Input, Label } from '@librechat/client';
import type { MCPServerFormData } from '../hooks/useMCPServerForm';
import { isValidUrl, normalizeUrl } from '../utils/urlUtils';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

export default function ConnectionSection() {
  const localize = useLocalize();
  const {
    register,
    formState: { errors },
  } = useFormContext<MCPServerFormData>();

  return (
    <div className="space-y-1.5">
      <Label htmlFor="url" className="text-sm font-medium">
        {localize('com_ui_mcp_url')}{' '}
        <span aria-hidden="true" className="text-text-secondary">
          *
        </span>
        <span className="sr-only">{localize('com_ui_field_required')}</span>
      </Label>
      <Input
        id="url"
        type="url"
        autoComplete="off"
        placeholder={localize('com_ui_mcp_server_url_placeholder')}
        aria-invalid={errors.url ? 'true' : 'false'}
        aria-describedby={errors.url ? 'url-error' : undefined}
        {...register('url', {
          required: localize('com_ui_field_required'),
          validate: (value) => {
            const normalized = normalizeUrl(value);
            return isValidUrl(normalized) || localize('com_ui_mcp_invalid_url');
          },
        })}
        className={cn(errors.url && 'border-border-destructive')}
      />
      {errors.url && (
        <p id="url-error" role="alert" className="text-text-destructive text-xs">
          {errors.url.message}
        </p>
      )}
    </div>
  );
}
