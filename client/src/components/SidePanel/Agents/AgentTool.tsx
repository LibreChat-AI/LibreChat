import React, { useState } from 'react';
import { Wrench } from 'lucide-react';
import { useFormContext } from 'react-hook-form';
import { useUpdateUserPluginsMutation } from 'librechat-data-provider/react-query';
import {
  Button,
  OGDialog,
  TrashIcon,
  CircleHelpIcon,
  useToastContext,
  OGDialogTrigger,
  OGDialogTemplate,
} from '@librechat/client';
import type { TPlugin } from 'librechat-data-provider';
import type { AgentForm } from '~/common';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

export default function AgentTool({
  tool,
  regularTools,
}: {
  tool: string;
  regularTools?: TPlugin[];
  agent_id?: string;
}) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const updateUserPlugins = useUpdateUserPluginsMutation();
  const { getValues, setValue } = useFormContext<AgentForm>();

  const [isFocused, setIsFocused] = useState(false);
  const [isHovering, setIsHovering] = useState(false);

  if (!regularTools) {
    return null;
  }

  const currentTool = regularTools.find((t) => t.pluginKey === tool);

  if (!currentTool) {
    return null;
  }

  const removeTool = (toolId: string) => {
    if (toolId) {
      updateUserPlugins.mutate(
        { pluginKey: toolId, action: 'uninstall', auth: {}, isEntityTool: true },
        {
          onError: (error: unknown) => {
            showToast({
              message: localize('com_ui_delete_tool_error_var', { 0: String(error) }),
              status: 'error',
            });
          },
          onSuccess: () => {
            const remainingToolIds = getValues('tools')?.filter((id: string) => id !== toolId);
            setValue('tools', remainingToolIds);
            showToast({ message: localize('com_ui_delete_tool_success'), status: 'success' });
          },
        },
      );
    }
  };

  return (
    <OGDialog>
      <div
        className="group relative flex w-full items-center gap-1 rounded-lg p-1 text-sm hover:bg-gray-50 dark:hover:bg-gray-800/50"
        onMouseEnter={() => setIsHovering(true)}
        onMouseLeave={() => setIsHovering(false)}
        onFocus={() => setIsFocused(true)}
        onBlur={(e) => {
          // Check if focus is moving to a child element
          if (!e.currentTarget.contains(e.relatedTarget)) {
            setIsFocused(false);
          }
        }}
      >
        <div className="flex grow items-center">
          <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center overflow-hidden rounded-full">
            {currentTool.icon ? (
              <div
                className="flex h-6 w-6 items-center justify-center overflow-hidden rounded-full bg-center bg-no-repeat dark:bg-white/20"
                style={{
                  backgroundImage: `url(${currentTool.icon})`,
                  backgroundSize: 'cover',
                }}
              />
            ) : (
              <div className="flex h-6 w-6 items-center justify-center rounded-md bg-surface-secondary text-text-secondary">
                <Wrench className="h-3.5 w-3.5" aria-hidden="true" />
              </div>
            )}
          </div>
          <div
            className="grow px-2 py-1.5"
            style={{ textOverflow: 'ellipsis', wordBreak: 'break-all', overflow: 'hidden' }}
          >
            {currentTool.name}
          </div>
        </div>

        <OGDialogTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              'h-7 w-7 rounded transition-all duration-200 hover:bg-surface-hover',
              'focus:opacity-100 focus-visible:opacity-100',
              isHovering || isFocused ? 'opacity-100' : 'pointer-events-none opacity-0',
            )}
            aria-label={localize('com_ui_delete_var', { 0: currentTool.name })}
            tabIndex={0}
            onFocus={() => setIsFocused(true)}
          >
            <TrashIcon className="h-4 w-4" />
          </Button>
        </OGDialogTrigger>
      </div>
      <OGDialogTemplate
        showCloseButton={false}
        title={localize('com_ui_delete_tool')}
        className="max-w-[450px]"
        main={
          <>
            <div className="flex w-full flex-col items-start gap-2 text-sm text-text-secondary">
              <p>
                {localize('com_ui_delete_tool_confirm')}{' '}
                <strong>&quot;{currentTool.name}&quot;</strong>?
              </p>
              {currentTool.description && (
                <div className="flex items-start gap-2">
                  <CircleHelpIcon className="h-4 w-4 flex-shrink-0 text-text-secondary" />
                  <p className="text-sm">{currentTool.description}</p>
                </div>
              )}
            </div>
          </>
        }
        selection={{
          selectHandler: () => removeTool(tool),
          selectClasses:
            'bg-surface-destructive hover:bg-surface-destructive-hover text-text-on-status',
          selectText: localize('com_ui_delete'),
        }}
      />
    </OGDialog>
  );
}
