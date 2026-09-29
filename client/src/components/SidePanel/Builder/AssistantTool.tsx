import React, { useState } from 'react';
import { useFormContext } from 'react-hook-form';
import { useUpdateUserPluginsMutation } from 'librechat-data-provider/react-query';
import {
  OGDialog,
  OGDialogTrigger,
  Label,
  OGDialogTemplate,
  TrashIcon,
  useToastContext,
} from '@librechat/client';
import type { TPlugin } from 'librechat-data-provider';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

export default function AssistantTool({
  tool,
  allTools,
  assistant_id = '',
}: {
  tool: string;
  allTools: TPlugin[];
  assistant_id?: string;
}) {
  const [isHovering, setIsHovering] = useState(false);
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const updateUserPlugins = useUpdateUserPluginsMutation();
  const { getValues, setValue } = useFormContext();
  const currentTool = allTools.find((t) => t.pluginKey === tool);

  const removeTool = (tool: string) => {
    if (tool) {
      updateUserPlugins.mutate(
        { pluginKey: tool, action: 'uninstall', auth: null, isEntityTool: true },
        {
          onError: (error: unknown) => {
            showToast({ message: `Error while deleting the tool: ${error}`, status: 'error' });
          },
          onSuccess: () => {
            const fns = getValues('functions').filter((fn) => fn !== tool);
            setValue('functions', fns);
            showToast({ message: 'Tool deleted successfully', status: 'success' });
          },
        },
      );
    }
  };

  if (!currentTool) {
    return null;
  }

  return (
    <OGDialog>
      <div
        className={cn(
          'flex w-full items-center rounded-lg text-sm',
          !assistant_id ? 'opacity-40' : '',
        )}
        onMouseEnter={() => setIsHovering(true)}
        onMouseLeave={() => setIsHovering(false)}
      >
        <div className="flex grow items-center">
          {currentTool.icon && (
            <div className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-full">
              <div
                className="flex h-6 w-6 items-center justify-center overflow-hidden rounded-full bg-center bg-no-repeat dark:bg-white/20"
                style={{ backgroundImage: `url(${currentTool.icon})`, backgroundSize: 'cover' }}
              />
            </div>
          )}
          <div
            className="h-9 grow px-3 py-2"
            style={{ textOverflow: 'ellipsis', wordBreak: 'break-all', overflow: 'hidden' }}
          >
            {currentTool.name}
          </div>
        </div>

        {isHovering && (
          <OGDialogTrigger asChild>
            <button
              type="button"
              className="flex h-9 w-9 min-w-9 items-center justify-center rounded-lg transition-colors duration-200 hover:bg-gray-200 dark:hover:bg-gray-700"
            >
              <TrashIcon />
            </button>
          </OGDialogTrigger>
        )}
      </div>
      <OGDialogTemplate
        showCloseButton={false}
        title={localize('com_ui_delete_tool')}
        className="max-w-[450px]"
        main={
          <Label className="text-left text-sm font-medium">
            {localize('com_ui_delete_tool_confirm')}
          </Label>
        }
        selection={{
          selectHandler: () => removeTool(currentTool.pluginKey),
          selectClasses:
            'bg-surface-destructive hover:bg-surface-destructive-hover transition-colors duration-200 text-text-on-status',
          selectText: localize('com_ui_delete'),
        }}
      />
    </OGDialog>
  );
}
