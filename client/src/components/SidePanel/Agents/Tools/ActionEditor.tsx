import { useEffect } from 'react';
import { useForm, FormProvider } from 'react-hook-form';
import {
  AuthTypeEnum,
  AuthorizationTypeEnum,
  TokenExchangeMethodEnum,
} from 'librechat-data-provider';
import {
  Label,
  Button,
  OGDialog,
  TrashIcon,
  OGDialogTrigger,
  useToastContext,
  OGDialogTemplate,
} from '@librechat/client';
import type { ActionAuthForm } from '~/common';
import ActionsAuth from '~/components/SidePanel/Builder/ActionsAuth';
import { useAgentPanelContext } from '~/Providers/AgentPanelContext';
import { useDeleteAgentAction } from '~/data-provider';
import { isEphemeralAgent } from '~/common';
import ActionsInput from '../ActionsInput';
import { useLocalize } from '~/hooks';

interface ActionEditorProps {
  agentId: string;
  onClose: () => void;
  onDeleted?: () => void;
  onCreated?: () => void;
}

export default function ActionEditor({
  agentId,
  onClose,
  onDeleted,
  onCreated,
}: ActionEditorProps) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const { action, setAction } = useAgentPanelContext();

  const deleteAgentAction = useDeleteAgentAction({
    onSuccess: () => {
      showToast({
        message: localize('com_assistants_delete_actions_success'),
        status: 'success',
      });
      onDeleted?.();
      onClose();
    },
    onError(error) {
      showToast({
        message: (error as Error).message ?? localize('com_assistants_delete_actions_error'),
        status: 'error',
      });
    },
  });

  const methods = useForm<ActionAuthForm>({
    defaultValues: {
      /* General */
      type: AuthTypeEnum.None,
      saved_auth_fields: false,
      /* API key */
      api_key: '',
      authorization_type: AuthorizationTypeEnum.Basic,
      custom_auth_header: '',
      /* OAuth */
      oauth_client_id: '',
      oauth_client_secret: '',
      authorization_url: '',
      client_url: '',
      scope: '',
      token_exchange_method: TokenExchangeMethodEnum.DefaultPost,
    },
  });

  const { reset } = methods;

  useEffect(() => {
    if (action?.metadata.auth) {
      reset({
        type: action.metadata.auth.type || AuthTypeEnum.None,
        saved_auth_fields: false,
        api_key: action.metadata.api_key ?? '',
        authorization_type: action.metadata.auth.authorization_type || AuthorizationTypeEnum.Basic,
        oauth_client_id: action.metadata.oauth_client_id ?? '',
        oauth_client_secret: action.metadata.oauth_client_secret ?? '',
        authorization_url: action.metadata.auth.authorization_url ?? '',
        client_url: action.metadata.auth.client_url ?? '',
        scope: action.metadata.auth.scope ?? '',
        token_exchange_method:
          action.metadata.auth.token_exchange_method ?? TokenExchangeMethodEnum.DefaultPost,
      });
    }
  }, [action, reset]);

  const deleteButton = action ? (
    <OGDialog>
      <OGDialogTrigger asChild>
        <Button
          type="button"
          variant="destructive"
          size="icon"
          disabled={isEphemeralAgent(agentId) || !action.action_id}
          aria-label={localize('com_ui_delete_action')}
          title={localize('com_ui_delete_action')}
        >
          <TrashIcon className="h-4 w-4" />
        </Button>
      </OGDialogTrigger>
      <OGDialogTemplate
        showCloseButton={false}
        title={localize('com_ui_delete_action')}
        className="max-w-[450px]"
        main={
          <Label className="text-left text-sm font-medium">
            {localize('com_ui_delete_action_confirm')}
          </Label>
        }
        selection={{
          selectHandler: () => {
            if (isEphemeralAgent(agentId)) {
              return showToast({
                message: localize('com_agents_no_agent_id_error'),
                status: 'error',
              });
            }
            deleteAgentAction.mutate({
              action_id: action.action_id,
              agent_id: agentId,
            });
          },
          selectClasses:
            'bg-surface-destructive text-text-on-status transition-colors duration-200 hover:bg-surface-destructive-hover',
          selectText: localize('com_ui_delete'),
        }}
      />
    </OGDialog>
  ) : null;

  return (
    <FormProvider {...methods}>
      <form className="flex min-h-0 flex-1 flex-col text-sm">
        <ActionsAuth />
        <ActionsInput
          action={action}
          agent_id={agentId}
          setAction={setAction}
          onCreated={onCreated}
          footerStart={deleteButton}
        />
      </form>
    </FormProvider>
  );
}
