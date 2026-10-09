import { useCallback } from 'react';
import { useFormContext } from 'react-hook-form';
import { useToastContext } from '@librechat/client';
import type { AgentForm } from '~/common';
import { matchesMcpServer } from '~/components/SidePanel/Agents/Tools/items/selectors';
import { useLocalize } from '~/hooks';

/**
 * Hook for removing an MCP server (and all of its tools) from the agent form.
 * Note: This only removes the tool from the form, it does not delete associated auth credentials
 */
export function useRemoveMCPTool(options?: {
  showToast?: boolean;
  serverNames?: readonly string[];
}) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const { getValues, setValue } = useFormContext<AgentForm>();
  const shouldShowToast = options?.showToast !== false;
  const serverNames = options?.serverNames;

  const removeTool = useCallback(
    (serverName: string) => {
      if (!serverName) {
        return;
      }

      const currentTools = getValues('tools');
      const allServerNames = Array.from(new Set([...(serverNames ?? []), serverName]));
      /** Strip every token format the selection logic counts as this server —
       * removal lagging behind `matchesMcpServer` leaves the row permanently
       * selected with no way to clean it up. */
      const remainingToolIds =
        currentTools?.filter(
          (currentToolId) => !matchesMcpServer(currentToolId, serverName, allServerNames),
        ) || [];
      setValue('tools', remainingToolIds, { shouldDirty: true });

      if (shouldShowToast) {
        showToast({
          message: localize('com_ui_delete_tool_save_reminder'),
          status: 'warning',
        });
      }
    },
    [getValues, setValue, showToast, localize, shouldShowToast, serverNames],
  );

  return { removeTool };
}
