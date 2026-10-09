import { useRef } from 'react';
import { Button, SquirclePlusIcon } from '@librechat/client';
import CustomIcon from '~/components/ui/CustomIcon';
import { useLocalize } from '~/hooks';

interface MCPIconProps {
  icon?: string;
  onIconChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  /** Id of the alert explaining a rejected pick. */
  errorId?: string;
}

export default function MCPIcon({ icon, onIconChange, errorId }: MCPIconProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const localize = useLocalize();

  const handleClick = () => {
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
      fileInputRef.current.click();
    }
  };

  return (
    <div className="flex items-center gap-4">
      <Button
        variant="ghost"
        onClick={handleClick}
        aria-label={localize('com_ui_upload_icon')}
        aria-invalid={errorId != null}
        aria-describedby={errorId}
        className="border-border-medium bg-surface-secondary hover:bg-surface-hover flex h-16 w-16 shrink-0 items-center justify-center rounded-xl border-2 border-dashed p-0"
      >
        {icon ? (
          <CustomIcon
            src={icon}
            alt=""
            className="text-text-primary h-full w-full rounded-xl object-cover"
          />
        ) : (
          <SquirclePlusIcon />
        )}
      </Button>
      <div className="flex flex-col gap-1">
        <span className="text-text-secondary text-sm">
          {localize('com_ui_icon')} {localize('com_ui_optional')}
        </span>
        <span className="text-text-secondary text-xs">{localize('com_agents_mcp_icon_size')}</span>
      </div>
      <input
        accept="image/png,.png,image/jpeg,.jpg,.jpeg,image/gif,.gif,image/webp,.webp,image/svg+xml,.svg"
        multiple={false}
        type="file"
        style={{ display: 'none' }}
        onChange={onIconChange}
        ref={fileInputRef}
      />
    </div>
  );
}
