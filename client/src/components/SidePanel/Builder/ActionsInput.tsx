import { useState, useEffect } from 'react';
import debounce from 'lodash/debounce';
import { useFormContext } from 'react-hook-form';
import { Spinner, useToastContext } from '@librechat/client';
import {
  validateAndParseOpenAPISpec,
  openapiToFunction,
  AuthTypeEnum,
} from 'librechat-data-provider';
import type {
  Action,
  FunctionTool,
  ActionMetadata,
  ValidationResult,
  AssistantsEndpoint,
} from 'librechat-data-provider';
import type { ActionAuthForm, ActionWithNullableMetadata } from '~/common';
import type { Spec } from './ActionsTable';
import ActionCallback from '~/components/SidePanel/Builder/ActionCallback';
import { ActionsTable, columns } from './ActionsTable';
import { useAssistantsMapContext } from '~/Providers';
import { useUpdateAction } from '~/data-provider';
import { useLocalize } from '~/hooks';

const debouncedValidation = debounce(
  (input: string, callback: (result: ValidationResult) => void) => {
    const result = validateAndParseOpenAPISpec(input);
    callback(result);
  },
  800,
);

export default function ActionsInput({
  action,
  assistant_id,
  endpoint,
  version,
  setAction,
}: {
  action?: ActionWithNullableMetadata;
  assistant_id?: string;
  endpoint: AssistantsEndpoint;
  version: number | string;
  setAction: React.Dispatch<React.SetStateAction<Action | undefined>>;
}) {
  const handleResult = (result: ValidationResult) => {
    if (!result.status) {
      setData(null);
      setFunctions(null);
    }
    setValidationResult(result);
  };

  const localize = useLocalize();
  const { showToast } = useToastContext();
  const assistantMap = useAssistantsMapContext();
  const { handleSubmit, reset } = useFormContext<ActionAuthForm>();
  const [validationResult, setValidationResult] = useState<null | ValidationResult>(null);
  const [inputValue, setInputValue] = useState('');

  const [data, setData] = useState<Spec[] | null>(null);
  const [functions, setFunctions] = useState<FunctionTool[] | null>(null);

  useEffect(() => {
    const rawSpec = action?.metadata?.raw_spec ?? '';
    if (!rawSpec) {
      return;
    }
    setInputValue(rawSpec);
    debouncedValidation(rawSpec, handleResult);
  }, [action?.metadata?.raw_spec]);

  useEffect(() => {
    if (!validationResult || !validationResult.status || !validationResult.spec) {
      return;
    }

    const { functionSignatures, requestBuilders } = openapiToFunction(validationResult.spec);
    const specs = Object.entries(requestBuilders).map(([name, props]) => {
      return {
        name,
        method: props.method,
        path: props.path,
        domain: props.domain,
      };
    });

    setData(specs);
    setValidationResult(null);
    setFunctions(functionSignatures.map((f) => f.toObjectTool()));
  }, [validationResult]);

  const updateAction = useUpdateAction({
    onSuccess(data) {
      showToast({
        message: localize('com_assistants_update_actions_success'),
        status: 'success',
      });
      reset();
      setAction(data[2]);
    },
    onError(error) {
      showToast({
        message:
          (error as Error | undefined)?.message ?? localize('com_assistants_update_actions_error'),
        status: 'error',
      });
    },
  });

  const saveAction = handleSubmit((authFormData) => {
    console.log('authFormData', authFormData);
    const currentAssistantId = assistant_id ?? '';
    if (!currentAssistantId) {
      // alert user?
      return;
    }

    if (!functions) {
      return;
    }

    if (!data) {
      return;
    }

    let { metadata } = action ?? {};
    if (!metadata) {
      metadata = {};
    }
    const action_id = action?.action_id;
    metadata.raw_spec = inputValue;
    const parsedUrl = new URL(data[0].domain);
    if (!parsedUrl.hostname) {
      // alert user?
      return;
    }
    // Send protocol + hostname for proper SSRF validation (e.g., "http://192.168.1.1")
    metadata.domain = `${parsedUrl.protocol}//${parsedUrl.hostname}`;

    const { type, saved_auth_fields } = authFormData;

    const removeSensitiveFields = (obj: ActionMetadata) => {
      delete obj.auth;
      delete obj.api_key;
      delete obj.oauth_client_id;
      delete obj.oauth_client_secret;
    };

    if (saved_auth_fields && type === AuthTypeEnum.ServiceHttp) {
      metadata = {
        ...metadata,
        api_key: authFormData.api_key,
        auth: {
          type,
          authorization_type: authFormData.authorization_type,
          custom_auth_header: authFormData.custom_auth_header,
        },
      };
    } else if (saved_auth_fields && type === AuthTypeEnum.OAuth) {
      metadata = {
        ...metadata,
        auth: {
          type,
          authorization_url: authFormData.authorization_url,
          client_url: authFormData.client_url,
          scope: authFormData.scope,
          token_exchange_method: authFormData.token_exchange_method,
        },
        oauth_client_id: authFormData.oauth_client_id,
        oauth_client_secret: authFormData.oauth_client_secret,
      };
    } else if (saved_auth_fields) {
      removeSensitiveFields(metadata);
      metadata.auth = {
        type,
      };
    } else {
      removeSensitiveFields(metadata);
    }

    updateAction.mutate({
      action_id,
      metadata,
      functions,
      assistant_id: currentAssistantId,
      endpoint,
      version,
      model: assistantMap?.[endpoint][currentAssistantId].model ?? '',
    });
  });

  const handleInputChange: React.ChangeEventHandler<HTMLTextAreaElement> = (event) => {
    const newValue = event.target.value;
    setInputValue(newValue);
    if (!newValue) {
      setData(null);
      setFunctions(null);
      return setValidationResult(null);
    }
    debouncedValidation(newValue, handleResult);
  };

  const submitContext = () => {
    if (updateAction.isLoading) {
      return <Spinner className="icon-md" />;
    } else if (action?.action_id.length ?? 0) {
      return localize('com_ui_update');
    } else {
      return localize('com_ui_create');
    }
  };

  return (
    <>
      <div className="">
        <div className="mb-1 flex flex-wrap items-center justify-between gap-4">
          <label
            htmlFor="example-schema"
            className="text-token-text-primary whitespace-nowrap font-medium"
          >
            {localize('com_ui_schema')}
          </label>
          {/* TODO: Implement examples functionality
          <div className="flex items-center gap-2">
            <select
              id="example-schema"
              onChange={(e) => console.log(e.target.value)}
              className="border-token-border-medium h-8 min-w-[100px] rounded-lg border bg-transparent px-2 py-0 text-sm"
            >
              <option value="label">{localize('com_ui_examples')}</option>
              <option value="0">Weather (JSON)</option>
              <option value="1">Pet Store (YAML)</option>
              <option value="2">Blank Template</option>
            </select>
          </div>
          */}
        </div>
        <div className="border-token-border-medium mb-4 w-full overflow-hidden rounded-lg border bg-surface-primary ring-0 hover:border-border-heavy">
          <div className="relative">
            <textarea
              id="schemaInput"
              value={inputValue}
              onChange={handleInputChange}
              spellCheck="false"
              placeholder={localize('com_ui_enter_openapi_schema')}
              className="text-token-text-primary block h-96 w-full bg-transparent p-2 font-mono text-xs outline-none focus:ring-1 focus:ring-border-light"
            />
            {/* TODO: format input button */}
          </div>
          {validationResult && validationResult.message !== 'OpenAPI spec is valid.' && (
            <div className="border-token-border-light border-t p-2 text-text-destructive">
              {validationResult.message.split('\n').map((line: string, i: number) => (
                <div key={i}>{line}</div>
              ))}
            </div>
          )}
        </div>
      </div>
      {!!data && (
        <div className="my-2">
          <div className="flex items-center">
            <label className="text-token-text-primary block font-medium">
              {localize('com_assistants_available_actions')}
            </label>
          </div>
          <ActionsTable columns={columns} data={data} />
        </div>
      )}
      <div className="relative my-1">
        <ActionCallback action_id={action?.action_id} />
        <div className="mb-1.5 flex items-center">
          <label className="text-token-text-primary block font-medium">
            {localize('com_ui_privacy_policy_url')}
          </label>
        </div>
        <div className="border-token-border-medium flex h-9 w-full rounded-lg border bg-surface-primary hover:border-border-heavy">
          <input
            type="text"
            placeholder="https://api.example-weather-app.com/privacy"
            className="flex-1 rounded-lg bg-transparent px-3 py-1.5 text-sm outline-none placeholder:text-text-secondary-alt focus:ring-1 focus:ring-border-light"
          />
        </div>
      </div>
      <div className="flex items-center justify-end">
        <button
          disabled={!functions || !functions.length}
          onClick={saveAction}
          className="mt-1 flex min-w-[100px] items-center justify-center rounded bg-surface-submit px-4 py-2 font-semibold text-text-on-status hover:bg-surface-submit-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-text-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface-primary disabled:opacity-50"
          type="button"
        >
          {submitContext()}
        </button>
      </div>
    </>
  );
}
