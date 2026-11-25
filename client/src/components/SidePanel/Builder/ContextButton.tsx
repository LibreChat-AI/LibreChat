import { useQueryClient } from '@tanstack/react-query';
import { QueryKeys, defaultOrderQuery } from 'librechat-data-provider';
import {
  Label,
  Button,
  OGDialog,
  TrashIcon,
  OGDialogTrigger,
  useToastContext,
  OGDialogTemplate,
} from '@librechat/client';
import type {
  Assistant,
  AssistantListResponse,
  AssistantCreateParams,
  AssistantsEndpoint,
} from 'librechat-data-provider';
import type { UseMutationResult } from '@tanstack/react-query';
import { useDeleteAssistantMutation } from '~/data-provider';
import { useChatContext } from '~/Providers';
import { useLocalize } from '~/hooks';

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
  createMutation: Pick<
    UseMutationResult<Assistant, Error, AssistantCreateParams>,
    'data' | 'reset'
  >;
  endpoint: AssistantsEndpoint;
}) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const { setConversation } = useChatContext();
  const queryClient = useQueryClient();

  const deleteAssistant = useDeleteAssistantMutation({
    onSuccess: (_, vars) => {
      const updatedList =
        queryClient.getQueryData<AssistantListResponse>([
          QueryKeys.assistants,
          vars.endpoint,
          defaultOrderQuery,
        ])?.data ?? [];

      showToast({
        message: localize('com_ui_assistant_deleted'),
        status: 'success',
      });

      if (createMutation.data?.id !== undefined) {
        console.log('[deleteAssistant] resetting createMutation');
        createMutation.reset();
      }

      const firstAssistant = updatedList[0];
      setConversation((current) => {
        if (
          !current ||
          current.endpoint !== vars.endpoint ||
          current.assistant_id !== vars.assistant_id
        ) {
          return current;
        }
        return { ...current, assistant_id: firstAssistant?.id ?? '', model: firstAssistant?.model };
      });
      setCurrentAssistantId((current) =>
        current === vars.assistant_id || !updatedList.some((assistant) => assistant.id === current)
          ? firstAssistant?.id
          : current,
      );
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
    <OGDialog>
      <OGDialogTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          aria-label={localize('com_ui_delete_assistant')}
          title={localize('com_ui_delete_assistant')}
          type="button"
        >
          <div className="text-text-destructive flex w-full items-center justify-center gap-2">
            <TrashIcon />
          </div>
        </Button>
      </OGDialogTrigger>
      <OGDialogTemplate
        title={localize('com_ui_delete_assistant')}
        className="max-w-[28.125rem]"
        main={
          <>
            <div className="flex w-full flex-col items-center gap-2">
              <div className="grid w-full items-center gap-2">
                <Label htmlFor="delete-assistant" className="text-start text-sm font-medium">
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
    </OGDialog>
  );
}
