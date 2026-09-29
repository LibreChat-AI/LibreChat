import { useState, useEffect } from 'react';
import debounce from 'lodash/debounce';
import { Maximize2 } from 'lucide-react';
import { useFormContext } from 'react-hook-form';
import {
  validateAndParseOpenAPISpec,
  openapiToFunction,
  AuthTypeEnum,
} from 'librechat-data-provider';
import {
  Label,
  Button,
  Spinner,
  Textarea,
  OGDialog,
  TooltipAnchor,
  OGDialogTitle,
  OGDialogHeader,
  OGDialogContent,
  OGDialogDescription,
  useToastContext,
} from '@librechat/client';
import type {
  Action,
  FunctionTool,
  ActionMetadata,
  ValidationResult,
} from 'librechat-data-provider';
import type { ActionAuthForm } from '~/common';
import type { Spec } from './ActionsTable';
import { ActionsTable, ActionsTableSkeleton, columns } from './ActionsTable';
import ActionCallback from '~/components/SidePanel/Builder/ActionCallback';
import { useUpdateAgentAction } from '~/data-provider';
import { useLocalize } from '~/hooks';
import { logger } from '~/utils';

const debouncedValidation = debounce(
  (input: string, callback: (result: ValidationResult) => void) => {
    const result = validateAndParseOpenAPISpec(input);
    callback(result);
  },
  800,
);

/** Placeholder rows shaped like the "Available actions" table (Name / Method / Path). */
export default function ActionsInput({
  action,
  agent_id,
  setAction,
  onCreated,
  footerStart,
}: {
  action?: Action;
  agent_id?: string;
  setAction: React.Dispatch<React.SetStateAction<Action | undefined>>;
  onCreated?: () => void;
  footerStart?: React.ReactNode;
}) {
  const handleResult = (result: ValidationResult) => {
    if (!result.status) {
      setData(null);
      setFunctions(null);
      setIsValidating(false);
    }
    setValidationResult(result);
  };

  const localize = useLocalize();
  const { showToast } = useToastContext();
  const { handleSubmit, reset } = useFormContext<ActionAuthForm>();
  const [validationResult, setValidationResult] = useState<null | ValidationResult>(null);
  const [inputValue, setInputValue] = useState('');
  const [isValidating, setIsValidating] = useState(false);
  const [isSchemaDialogOpen, setIsSchemaDialogOpen] = useState(false);

  const [data, setData] = useState<Spec[] | null>(null);
  const [functions, setFunctions] = useState<FunctionTool[] | null>(null);

  useEffect(() => {
    const rawSpec = action?.metadata.raw_spec ?? '';
    if (!rawSpec) {
      return;
    }
    setInputValue(rawSpec);
    setIsValidating(true);
    handleResult(validateAndParseOpenAPISpec(rawSpec));
  }, [action?.metadata.raw_spec]);

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
    setIsValidating(false);
  }, [validationResult]);

  const updateAgentAction = useUpdateAgentAction({
    onSuccess(data) {
      const wasCreate = !action?.action_id;
      showToast({
        message: localize('com_assistants_update_actions_success'),
        status: 'success',
      });
      reset();
      setAction(data[1]);
      if (wasCreate) {
        onCreated?.();
      }
    },
    onError(error) {
      showToast({
        message: (error as Error).message || localize('com_assistants_update_actions_error'),
        status: 'error',
      });
    },
  });

  const saveAction = handleSubmit((authFormData) => {
    logger.log('actions', 'saving action', authFormData);
    const currentAgentId = agent_id ?? '';
    if (!currentAgentId) {
      // alert user?
      return;
    }

    if (!functions) {
      return;
    }

    if (!data) {
      return;
    }

    let { metadata = {} } = action ?? {};
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

    updateAgentAction.mutate({
      action_id,
      metadata,
      functions,
      agent_id: currentAgentId,
    });
  });

  const handleInputChange: React.ChangeEventHandler<HTMLTextAreaElement> = (event) => {
    const newValue = event.target.value;
    setInputValue(newValue);
    if (!newValue) {
      setData(null);
      setFunctions(null);
      setIsValidating(false);
      return setValidationResult(null);
    }
    setIsValidating(true);
    debouncedValidation(newValue, handleResult);
  };

  const getButtonContent = () => {
    if (updateAgentAction.isLoading) {
      return <Spinner className="icon-md" />;
    }

    if (action?.action_id != null && action.action_id) {
      return localize('com_ui_update');
    }

    return localize('com_ui_create');
  };

  const validationError =
    validationResult && validationResult.message !== 'OpenAPI spec is valid.'
      ? validationResult.message
      : null;
  const showSkeleton = isValidating && !data;

  return (
    <>
      <div className="flex shrink-0 flex-col">
        <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
          <label
            htmlFor="schemaInput"
            className="whitespace-nowrap text-sm font-medium text-text-primary"
          >
            {localize('com_ui_schema')}
          </label>
          <TooltipAnchor
            side="top"
            description={localize('com_ui_expand_editor')}
            render={
              <button
                type="button"
                onClick={() => setIsSchemaDialogOpen(true)}
                aria-label={localize('com_ui_expand_editor')}
                className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-surface-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text-primary"
              >
                <Maximize2 className="h-4 w-4" strokeWidth={1.75} aria-hidden={true} />
              </button>
            }
          />
        </div>
        <Textarea
          id="schemaInput"
          value={inputValue}
          onChange={handleInputChange}
          spellCheck="false"
          placeholder={localize('com_ui_enter_openapi_schema')}
          className="block min-h-[12rem] w-full resize-y rounded-lg border border-border-light bg-transparent p-3 font-mono text-xs leading-relaxed transition-colors focus-visible:border-border-heavy focus-visible:ring-0"
        />
        {validationError && (
          <div className="mt-1.5 text-xs text-text-destructive">
            {validationError.split('\n').map((line: string, i: number) => (
              <div key={i}>{line}</div>
            ))}
          </div>
        )}
      </div>
      {(data || showSkeleton) && (
        <div className="mt-4 flex min-h-0 flex-1 flex-col">
          <Label className="mb-1 shrink-0 font-medium">
            {localize('com_assistants_available_actions')}
          </Label>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {data ? <ActionsTable columns={columns} data={data} /> : <ActionsTableSkeleton />}
          </div>
        </div>
      )}
      <div className="mt-4 shrink-0">
        <ActionCallback action_id={action?.action_id} />
      </div>
      <div className="flex shrink-0 items-center justify-between gap-2 pt-4">
        <div className="flex items-center">{footerStart}</div>
        <Button
          type="button"
          variant="submit"
          onClick={saveAction}
          disabled={!functions || !functions.length}
          className="min-w-[100px]"
        >
          {getButtonContent()}
        </Button>
      </div>

      <OGDialog open={isSchemaDialogOpen} onOpenChange={setIsSchemaDialogOpen}>
        <OGDialogContent className="flex h-[85vh] max-h-[85vh] w-11/12 max-w-5xl flex-col gap-3 p-5">
          <OGDialogHeader className="space-y-0 pr-10">
            <OGDialogTitle className="text-left text-sm font-medium text-text-primary">
              {localize('com_ui_schema')}
            </OGDialogTitle>
            <OGDialogDescription className="sr-only">
              {localize('com_ui_enter_openapi_schema')}
            </OGDialogDescription>
          </OGDialogHeader>
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border-medium bg-surface-secondary focus-within:border-border-heavy">
            <Textarea
              value={inputValue}
              onChange={handleInputChange}
              spellCheck="false"
              placeholder={localize('com_ui_enter_openapi_schema')}
              aria-label={localize('com_ui_schema')}
              className="min-h-0 flex-1 resize-none border-0 bg-transparent p-4 font-mono text-[13px] leading-relaxed focus-visible:ring-0"
            />
          </div>
          {validationError && (
            <div className="max-h-24 shrink-0 overflow-y-auto text-xs text-text-destructive">
              {validationError.split('\n').map((line: string, i: number) => (
                <div key={i}>{line}</div>
              ))}
            </div>
          )}
        </OGDialogContent>
      </OGDialog>
    </>
  );
}
