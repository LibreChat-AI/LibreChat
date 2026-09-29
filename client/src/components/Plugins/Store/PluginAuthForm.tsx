import { useForm, useWatch } from 'react-hook-form';
import {
  Input,
  Label,
  Button,
  Spinner,
  HoverCard,
  SecretInput,
  HoverCardTrigger,
} from '@librechat/client';
import type { TPlugin, TPluginAuthConfig, TPluginAction } from 'librechat-data-provider';
import type { RegisterOptions } from 'react-hook-form';
import PluginTooltip from './PluginTooltip';
import { useLocalize } from '~/hooks';

/**
 * Format-hint placeholders per credential, keyed by the primary `authField`
 * (the part before any `||` alternates). These are literal format tokens
 * (e.g. an OpenAI key's `sk-` prefix), not translatable copy, so they are not
 * localized. Fields without a recognizable format fall through to no
 * placeholder.
 */
const AUTH_PLACEHOLDERS: Record<string, string> = {
  // OpenAI-issued keys start with "sk-"
  OPENAI_API_KEY: 'sk-...',
  DALLE_API_KEY: 'sk-...',
  DALLE2_API_KEY: 'sk-...',
  DALLE3_API_KEY: 'sk-...',
  IMAGE_GEN_OAI_API_KEY: 'sk-...',
  // Google AI / Cloud keys start with "AIza"
  GEMINI_API_KEY: 'AIza...',
  GOOGLE_KEY: 'AIza...',
  GOOGLE_SEARCH_API_KEY: 'AIza...',
  GOOGLE_CSE_ID: 'a1b2c3d4e5f6g7h8i',
  // Tavily keys start with "tvly-"
  TAVILY_API_KEY: 'tvly-...',
  // Wolfram AppID format
  WOLFRAM_APP_ID: 'XXXXXX-XXXXXXXXXX',
  // URL / endpoint / index-name fields
  SD_WEBUI_URL: 'http://localhost:7860',
  AZURE_AI_SEARCH_SERVICE_ENDPOINT: 'https://<service>.search.windows.net',
  AZURE_AI_SEARCH_INDEX_NAME: 'my-index',
};

/**
 * Endpoint/URL fields, keyed by primary `authField`. These get a hard validation
 * rule: a value that isn't a valid http(s) URL blocks submission.
 */
const URL_FIELDS = new Set<string>(['SD_WEBUI_URL', 'AZURE_AI_SEARCH_SERVICE_ENDPOINT']);

/**
 * Known credential prefixes per primary `authField`. A value missing its expected
 * prefix surfaces a non-blocking hint, never an error — key formats drift over
 * time, so we guide without trapping a key that just doesn't match.
 */
const AUTH_PREFIXES: Record<string, string> = {
  OPENAI_API_KEY: 'sk-',
  DALLE_API_KEY: 'sk-',
  DALLE2_API_KEY: 'sk-',
  DALLE3_API_KEY: 'sk-',
  IMAGE_GEN_OAI_API_KEY: 'sk-',
  GEMINI_API_KEY: 'AIza',
  GOOGLE_KEY: 'AIza',
  GOOGLE_SEARCH_API_KEY: 'AIza',
  TAVILY_API_KEY: 'tvly-',
};

const isValidUrl = (value: string): boolean => {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
};

type TPluginAuthFormProps = {
  plugin: TPlugin | undefined;
  onSubmit: (installActionData: TPluginAction) => void;
  isEntityTool?: boolean;
  /** External in-flight state (e.g. a mutation) so the button reflects the real save. */
  isSaving?: boolean;
  /** When provided, renders a Cancel button (used when re-editing saved credentials). */
  onCancel?: () => void;
};

function PluginAuthForm({
  plugin,
  onSubmit,
  isEntityTool,
  isSaving,
  onCancel,
}: TPluginAuthFormProps) {
  const {
    register,
    control,
    handleSubmit,
    formState: { errors, isDirty, isValid, isSubmitting },
  } = useForm({ mode: 'onChange' });

  const localize = useLocalize();
  const watchedValues = useWatch({ control });
  const authConfig = plugin?.authConfig ?? [];
  const allFieldsOptional = authConfig.length > 0 && authConfig.every((c) => c.optional === true);
  const saving = isSubmitting || isSaving === true;

  const submit = handleSubmit((auth) =>
    onSubmit({
      pluginKey: plugin?.pluginKey ?? '',
      action: 'install',
      auth,
      isEntityTool,
    }),
  );

  return (
    <form className="flex w-full flex-col" method="POST" onSubmit={submit}>
      <div className="flex max-h-[40vh] flex-col gap-4 overflow-y-auto pr-1">
        {authConfig.map((config: TPluginAuthConfig, i: number) => {
          const authField = config.authField.split('||')[0];
          const isOptional = config.optional === true;
          const rules: RegisterOptions = {};
          if (!isOptional) {
            rules.required = `${config.label} is required.`;
            rules.minLength = {
              value: 1,
              message: `${config.label} must be at least 1 character long`,
            };
          }
          if (URL_FIELDS.has(authField)) {
            rules.validate = (value: string) =>
              !value || isValidUrl(value) || localize('com_ui_auth_invalid_url');
          }
          const hasError = !!errors[authField];
          const expectedPrefix = AUTH_PREFIXES[authField];
          const value = String(watchedValues?.[authField] ?? '');
          const showHint =
            !hasError && !!expectedPrefix && value.length > 0 && !value.startsWith(expectedPrefix);
          const describedBy = showHint
            ? `${authField}-error ${authField}-hint`
            : `${authField}-error`;
          const reserveMessage = !isOptional || URL_FIELDS.has(authField) || !!expectedPrefix;
          const sharedProps = {
            id: authField,
            placeholder: AUTH_PLACEHOLDERS[authField],
            'aria-invalid': hasError,
            'aria-describedby': describedBy,
            'aria-label': config.label,
            'aria-required': !isOptional,
            /* autoFocus is generally disorienting, but here the required field must be navigated to
             * anyway, and the form emulates a modal opening where users expect focus to shift. */
            autoFocus: i === 0,
            className:
              'hover:border-border-light focus-visible:border-border-light focus-visible:ring-2 focus-visible:ring-text-primary',
            ...register(authField, rules),
          };
          return (
            <div key={`${authField}-${i}`} className="flex w-full flex-col gap-1.5">
              <Label htmlFor={authField} className="text-sm font-medium text-text-secondary">
                {config.label}
              </Label>
              <HoverCard openDelay={300}>
                <HoverCardTrigger className="block w-full">
                  {config.sensitive === false ? (
                    <Input type="text" autoComplete="off" {...sharedProps} />
                  ) : (
                    <SecretInput
                      autoComplete="new-password"
                      data-lpignore="true"
                      data-1p-ignore="true"
                      controlsOnHover
                      {...sharedProps}
                    />
                  )}
                </HoverCardTrigger>
                <PluginTooltip content={config.description} position="right" />
              </HoverCard>
              {reserveMessage && (
                <div className="min-h-4 text-xs leading-4">
                  {hasError && (
                    <span id={`${authField}-error`} role="alert" className="text-text-destructive">
                      {String(errors?.[authField]?.message ?? '')}
                    </span>
                  )}
                  {showHint && (
                    <span id={`${authField}-hint`} aria-live="polite" className="text-text-warning">
                      {localize('com_ui_auth_format_hint', { 0: expectedPrefix })}
                    </span>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        {onCancel && (
          <Button type="button" variant="outline" disabled={saving} onClick={onCancel}>
            {localize('com_ui_cancel')}
          </Button>
        )}
        <Button
          type="button"
          variant="submit"
          disabled={allFieldsOptional ? saving : !isDirty || !isValid || saving}
          onClick={submit}
        >
          {saving && <Spinner className="size-4" aria-hidden="true" />}
          {saving ? localize('com_ui_saving') : localize('com_ui_save')}
        </Button>
      </div>
    </form>
  );
}

export default PluginAuthForm;
