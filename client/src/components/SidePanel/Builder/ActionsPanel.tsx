import { useEffect } from 'react';
import { ChevronLeft } from 'lucide-react';
import { useForm, FormProvider } from 'react-hook-form';
import {
  AuthTypeEnum,
  AuthorizationTypeEnum,
  TokenExchangeMethodEnum,
} from 'librechat-data-provider';
import {
  OGDialog,
  OGDialogTrigger,
  Label,
  OGDialogTemplate,
  useToastContext,
  TrashIcon,
} from '@librechat/client';
import type { AssistantPanelProps, ActionAuthForm } from '~/common';
import { useAssistantsMapContext } from '~/Providers';
import { useDeleteAction } from '~/data-provider';
import ActionsInput from './ActionsInput';
import ActionsAuth from './ActionsAuth';
import { useLocalize } from '~/hooks';
import { Panel } from '~/common';

export default function ActionsPanel({
  // activePanel,
  action,
  endpoint,
  version,
  setAction,
  assistant_id,
  setActivePanel,
}: AssistantPanelProps) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const assistantMap = useAssistantsMapContext();
  const deleteAction = useDeleteAction({
    onSuccess: () => {
      showToast({
        message: localize('com_assistants_delete_actions_success'),
        status: 'success',
      });
      setActivePanel(Panel.builder);
      setAction(undefined);
    },
    onError(error) {
      showToast({
        message:
          (error as Error | undefined)?.message ?? localize('com_assistants_delete_actions_error'),
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
    if (action?.metadata?.auth) {
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

  return (
    <FormProvider {...methods}>
      <form className="h-full grow overflow-hidden">
        <div className="h-full overflow-auto px-2 pb-12 text-sm">
          <div className="flex flex-col py-3">
            <header className="grid grid-cols-[auto_1fr_auto] items-center gap-2 pt-1">
              <button
                type="button"
                onClick={() => {
                  setActivePanel(Panel.builder);
                  setAction(undefined);
                }}
                aria-label={localize('com_ui_back_to_builder')}
                className="inline-flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl border border-border-light text-text-secondary transition-colors hover:bg-surface-secondary hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-ring-primary"
              >
                <ChevronLeft className="h-5 w-5" strokeWidth={1.75} aria-hidden="true" />
              </button>
              <h2 className="text-center text-base font-semibold text-text-primary">
                {localize(action ? 'com_assistants_edit_actions' : 'com_assistants_add_actions')}
              </h2>
              {action ? (
                <OGDialog>
                  <OGDialogTrigger asChild>
                    <button
                      type="button"
                      disabled={!(assistant_id ?? '') || !action.action_id}
                      aria-label={localize('com_ui_delete_action')}
                      className="inline-flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl border border-border-light text-red-500 transition-colors hover:bg-surface-secondary focus:outline-none focus-visible:ring-2 focus-visible:ring-ring-primary disabled:opacity-50"
                    >
                      <TrashIcon className="h-4 w-4" />
                    </button>
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
                        const currentId = assistant_id ?? '';
                        if (!currentId) {
                          return showToast({
                            message: 'No assistant_id found, is the assistant created?',
                            status: 'error',
                          });
                        }
                        deleteAction.mutate({
                          model: assistantMap?.[endpoint][currentId].model ?? '',
                          action_id: action.action_id,
                          assistant_id: currentId,
                          endpoint,
                        });
                      },
                      selectClasses:
                        'bg-surface-destructive hover:bg-surface-destructive-hover transition-color duration-200 text-text-on-status',
                      selectText: localize('com_ui_delete'),
                    }}
                  />
                </OGDialog>
              ) : (
                <span aria-hidden="true" className="h-10 w-10" />
              )}
            </header>
            <p className="mt-1 text-center text-xs text-text-secondary">
              {localize('com_assistants_actions_info')}
            </p>
            {/* <div className="text-sm text-text-secondary">
            <a href="https://help.openai.com/en/articles/8554397-creating-a-gpt" target="_blank" rel="noreferrer" className="font-medium">Learn more.</a>
          </div> */}
          </div>
          <ActionsAuth disableOAuth={true} />
          <ActionsInput
            action={action}
            assistant_id={assistant_id}
            setAction={setAction}
            endpoint={endpoint}
            version={version}
          />
        </div>
      </form>
    </FormProvider>
  );
}
