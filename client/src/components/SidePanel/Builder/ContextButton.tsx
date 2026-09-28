import {
  Dialog,
  DialogTrigger,
  Label,
  DialogTemplate,
  useToastContext,
  TrashIcon,
} from '@librechat/client';
import type { Assistant, AssistantCreateParams, AssistantsEndpoint } from 'librechat-data-provider';
import type { UseMutationResult } from '@tanstack/react-query';
import { useDeleteAssistantMutation } from '~/data-provider';
import { useLocalize, useSetIndexOptions } from '~/hooks';
import { cn, removeFocusOutlines } from '~/utils';
import { useChatContext } from '~/Providers';

export default function ContextButton({
  activeModel,
  assistant_id,
  setCurrentAssistantId,
  createMutation,
  endpoint,
}: {
  activeModel?: string;
  assistant_id: string;
  setCurrentAssistantId: React.Dispatch<React.SetStateAction<string | undefined>>;
  createMutation: UseMutationResult<Assistant, Error, AssistantCreateParams>;
  endpoint: AssistantsEndpoint;
}) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const { conversation } = useChatContext();
  const { setOption } = useSetIndexOptions();

  const deleteAssistant = useDeleteAssistantMutation({
    onSuccess: (_, vars, context) => {
      const updatedList = context as Assistant[] | undefined;
      if (!updatedList) {
        return;
      }

      showToast({
        message: localize('com_ui_assistant_deleted'),
        status: 'success',
      });

      if (createMutation.data?.id !== undefined) {
        console.log('[deleteAssistant] resetting createMutation');
        createMutation.reset();
      }

      const firstAssistant = updatedList[0] as Assistant | undefined;
      if (!firstAssistant) {
        return setOption('assistant_id')('');
      }

      if (vars.assistant_id === conversation?.assistant_id) {
        return setOption('assistant_id')(firstAssistant.id);
      }

      const currentAssistant = updatedList.find(
        (assistant) => assistant.id === conversation?.assistant_id,
      );

      if (currentAssistant) {
        setCurrentAssistantId(currentAssistant.id);
      }

      setCurrentAssistantId(firstAssistant.id);
    },
    onError: (error) => {
      console.error(error);
      showToast({
        message: localize('com_ui_assistant_delete_error'),
        status: 'error',
      });
    },
  });

  if (!assistant_id) {
    return null;
  }

  if (activeModel?.length === 0 || activeModel === undefined) {
    return null;
  }

  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          className={cn(
            'btn btn-neutral border-token-border-light relative h-9 rounded-lg font-medium',
            removeFocusOutlines,
          )}
          type="button"
        >
          <div className="flex w-full items-center justify-center gap-2 text-red-500">
            <TrashIcon />
          </div>
        </button>
      </DialogTrigger>
      <DialogTemplate
        title={localize('com_ui_delete_assistant')}
        className="max-w-[450px]"
        main={
          <>
            <div className="flex w-full flex-col items-center gap-2">
              <div className="grid w-full items-center gap-2">
                <Label htmlFor="delete-assistant" className="text-left text-sm font-medium">
                  {localize('com_ui_delete_assistant_confirm')}
                </Label>
              </div>
            </div>
          </>
        }
        selection={{
          selectHandler: () =>
            deleteAssistant.mutate({ assistant_id, model: activeModel, endpoint }),
          selectClasses:
            'bg-surface-destructive hover:bg-surface-destructive-hover text-text-on-status',
          selectText: localize('com_ui_delete'),
        }}
      />
    </Dialog>
  );
}
