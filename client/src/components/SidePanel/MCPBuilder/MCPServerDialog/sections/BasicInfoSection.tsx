import { useState } from 'react';
import { useFormContext } from 'react-hook-form';
import { Input, Label, Textarea } from '@librechat/client';
import { MAX_MCP_ICON_PATH_LENGTH, MCP_SERVER_TITLE_PATTERN } from 'librechat-data-provider';
import type { MCPServerFormData } from '../hooks/useMCPServerForm';
import MCPIcon from '~/components/SidePanel/Agents/MCPIcon';
import { cn, sanitizeSvg, svgToDataUri } from '~/utils';
import { useLocalize } from '~/hooks';

/** Largest file whose base64 data URI can still fit `MAX_MCP_ICON_PATH_LENGTH`. */
const MAX_ICON_FILE_BYTES = Math.floor((MAX_MCP_ICON_PATH_LENGTH * 3) / 4);
const MAX_ICON_FILE_KB = Math.floor(MAX_ICON_FILE_BYTES / 1024);

export default function BasicInfoSection() {
  const localize = useLocalize();
  const {
    register,
    watch,
    setValue,
    formState: { errors },
  } = useFormContext<MCPServerFormData>();

  const iconValue = watch('icon');
  /* Local rather than a form error: a rejected pick keeps the previous icon, so it
   * must not block saving the rest of the form. */
  const [iconRejected, setIconRejected] = useState(false);

  /* The server drops any icon over the cap, so refuse it here instead of previewing
   * an icon that vanishes on save. */
  const applyIcon = (dataUri: string) => {
    if (dataUri.length > MAX_MCP_ICON_PATH_LENGTH) {
      setIconRejected(true);
      return;
    }
    setIconRejected(false);
    setValue('icon', dataUri);
  };

  const handleIconChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) {
      return;
    }
    if (file.size > MAX_ICON_FILE_BYTES) {
      setIconRejected(true);
      return;
    }

    const reader = new FileReader();
    const isSvg = file.type === 'image/svg+xml' || /\.svg$/i.test(file.name);
    reader.onloadend = () => {
      if (typeof reader.result !== 'string') {
        return;
      }
      applyIcon(isSvg ? svgToDataUri(sanitizeSvg(reader.result)) : reader.result);
    };
    if (isSvg) {
      reader.readAsText(file);
    } else {
      reader.readAsDataURL(file);
    }
  };

  return (
    <div className="space-y-3">
      {/* Icon + Name row */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <div className="flex-shrink-0 space-y-1.5">
          <MCPIcon
            icon={iconValue}
            onIconChange={handleIconChange}
            errorId={iconRejected ? 'mcp-icon-error' : undefined}
          />
          {iconRejected && (
            <p id="mcp-icon-error" role="alert" className="text-xs text-text-destructive">
              {localize('com_ui_icon_too_large', { 0: MAX_ICON_FILE_KB })}
            </p>
          )}
        </div>
        <div className="w-full space-y-1.5 sm:flex-1">
          <Label htmlFor="mcp-title" className="text-sm font-medium">
            {localize('com_ui_name')}{' '}
            <span aria-hidden="true" className="text-text-secondary">
              *
            </span>
            <span className="sr-only">{localize('com_ui_field_required')}</span>
          </Label>
          <Input
            id="mcp-title"
            autoComplete="off"
            placeholder={localize('com_agents_mcp_name_placeholder')}
            aria-invalid={errors.title ? 'true' : 'false'}
            aria-describedby={errors.title ? 'mcp-title-error' : undefined}
            {...register('title', {
              required: localize('com_ui_field_required'),
              pattern: {
                value: MCP_SERVER_TITLE_PATTERN,
                message: localize('com_ui_mcp_title_invalid'),
              },
            })}
            className={cn(errors.title && 'border-border-destructive')}
          />
          {errors.title && (
            <p id="mcp-title-error" role="alert" className="text-xs text-text-destructive">
              {errors.title.message}
            </p>
          )}
        </div>
      </div>

      {/* Description */}
      <div className="space-y-1.5">
        <Label htmlFor="mcp-description" className="text-sm font-medium">
          {localize('com_ui_description')}{' '}
          <span className="text-xs text-text-secondary">{localize('com_ui_optional')}</span>
        </Label>
        <Textarea
          id="mcp-description"
          placeholder={localize('com_agents_mcp_description_placeholder')}
          {...register('description')}
        />
      </div>
    </div>
  );
}
