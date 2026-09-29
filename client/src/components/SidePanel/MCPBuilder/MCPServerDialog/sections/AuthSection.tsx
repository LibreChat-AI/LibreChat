import { useMemo, useState } from 'react';
import { Copy, CopyCheck } from 'lucide';
import { useFormContext, useWatch } from 'react-hook-form';
import { Permissions, PermissionTypes, TokenExchangeMethodEnum } from 'librechat-data-provider';
import {
  Label,
  Input,
  Radio,
  Checkbox,
  MorphIcon,
  SecretInput,
  useToastContext,
} from '@librechat/client';
import type { MCPServerFormData } from '../hooks/useMCPServerForm';
import { AuthTypeEnum, AuthorizationTypeEnum } from '../hooks/useMCPServerForm';
import { useLocalize, useCopyToClipboard, useHasAccess } from '~/hooks';
import { Collapse } from '~/components/ui';
import { cn } from '~/utils';

interface AuthSectionProps {
  isEditMode: boolean;
  serverName?: string;
}

const AUTO_TOKEN_EXCHANGE_METHOD = 'auto';

export default function AuthSection({ isEditMode, serverName }: AuthSectionProps) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const {
    register,
    setValue,
    formState: { errors },
  } = useFormContext<MCPServerFormData>();

  const [isCopying, setIsCopying] = useState(false);

  const canConfigureObo = useHasAccess({
    permissionType: PermissionTypes.MCP_SERVERS,
    permission: Permissions.CONFIGURE_OBO,
  });

  const authType = useWatch<MCPServerFormData, 'auth.auth_type'>({
    name: 'auth.auth_type',
  }) as AuthTypeEnum;

  const apiKeySource = useWatch<MCPServerFormData, 'auth.api_key_source'>({
    name: 'auth.api_key_source',
  }) as 'admin' | 'user';

  const authorizationType = useWatch<MCPServerFormData, 'auth.api_key_authorization_type'>({
    name: 'auth.api_key_authorization_type',
  }) as AuthorizationTypeEnum;

  const tokenExchangeMethod = useWatch<MCPServerFormData, 'auth.oauth_token_exchange_method'>({
    name: 'auth.oauth_token_exchange_method',
  });

  const redirectUri = serverName
    ? `${window.location.origin}/api/mcp/${serverName}/oauth/callback`
    : '';

  const copyLink = useCopyToClipboard({ text: redirectUri });

  /**
   * Show OBO as a selectable auth option only when the caller has the permission.
   * Edit-mode carve-out: if the form was loaded for a server that already uses OBO
   * and the caller has since lost the permission, surface OBO in the radio so the
   * current auth state is visible — but mark every OBO control disabled (and
   * disable the radio itself, so the user can't switch away) since the backend
   * also rejects modifying OBO without the permission.
   */
  const showOboOption = canConfigureObo || authType === AuthTypeEnum.OBO;
  const isOboLockedReadOnly = !canConfigureObo && authType === AuthTypeEnum.OBO;

  const authTypeOptions = useMemo(() => {
    const options = [
      { value: AuthTypeEnum.None, label: localize('com_ui_no_auth') },
      { value: AuthTypeEnum.ServiceHttp, label: localize('com_ui_api_key') },
      { value: AuthTypeEnum.OAuth, label: 'OAuth' },
    ];
    if (showOboOption) {
      options.push({
        value: AuthTypeEnum.OBO,
        label: localize('com_ui_obo'),
      });
    }
    return options;
  }, [localize, showOboOption]);

  const headerFormatOptions = useMemo(
    () => [
      { value: AuthorizationTypeEnum.Bearer, label: localize('com_ui_bearer') },
      { value: AuthorizationTypeEnum.Basic, label: localize('com_ui_basic') },
      { value: AuthorizationTypeEnum.Custom, label: localize('com_ui_custom') },
    ],
    [localize],
  );

  return (
    <div>
      {/* Auth Type Radio */}
      <fieldset className="space-y-1.5">
        <legend>
          <Label id="auth-type-label" className="text-sm font-medium">
            {localize('com_ui_authentication')}
          </Label>
        </legend>
        <Radio
          options={authTypeOptions}
          value={authType || AuthTypeEnum.None}
          onChange={(val) => setValue('auth.auth_type', val as AuthTypeEnum)}
          fullWidth
          disabled={isOboLockedReadOnly}
          aria-labelledby="auth-type-label"
        />
      </fieldset>

      {/* API Key Fields */}
      <Collapse open={authType === AuthTypeEnum.ServiceHttp} className="pt-3">
        <div className="space-y-3 rounded-lg border border-border-light p-3">
          {/* User provides own key checkbox + admin-provided key */}
          <div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="user_provides_key"
                checked={apiKeySource === 'user'}
                onCheckedChange={(checked) =>
                  setValue('auth.api_key_source', checked ? 'user' : 'admin')
                }
                aria-labelledby="user_provides_key_label"
              />
              <label
                id="user_provides_key_label"
                htmlFor="user_provides_key"
                className="cursor-pointer text-sm"
              >
                {localize('com_ui_user_provides_key')}
              </label>
            </div>

            {/* API Key input - only when admin provides */}
            <Collapse open={apiKeySource !== 'user'} className="pt-3">
              <div className="space-y-1.5">
                <Label htmlFor="api_key" className="text-sm font-medium">
                  {localize('com_ui_api_key')}
                </Label>
                <SecretInput
                  id="api_key"
                  placeholder="sk-..."
                  controlsOnHover
                  {...register('auth.api_key')}
                />
              </div>
            </Collapse>
          </div>

          {/* Header format + custom header name */}
          <div>
            <fieldset className="space-y-1.5">
              <legend>
                <Label id="header-format-label" className="text-sm font-medium">
                  {localize('com_ui_header_format')}
                </Label>
              </legend>
              <Radio
                options={headerFormatOptions}
                value={authorizationType || AuthorizationTypeEnum.Bearer}
                onChange={(val) =>
                  setValue('auth.api_key_authorization_type', val as AuthorizationTypeEnum)
                }
                fullWidth
                aria-labelledby="header-format-label"
              />
            </fieldset>

            {/* Custom header name */}
            <Collapse open={authorizationType === AuthorizationTypeEnum.Custom} className="pt-3">
              <div className="space-y-1.5">
                <Label htmlFor="custom_header" className="text-sm font-medium">
                  {localize('com_ui_custom_header_name')}
                </Label>
                <Input
                  id="custom_header"
                  placeholder="X-Api-Key"
                  {...register('auth.api_key_custom_header')}
                />
              </div>
            </Collapse>
          </div>
        </div>
      </Collapse>

      {/* OAuth Fields */}
      <Collapse open={authType === AuthTypeEnum.OAuth} className="pt-3">
        <div className="space-y-3 rounded-lg border border-border-light p-3">
          {/* Client ID & Secret in a grid */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="oauth_client_id" className="text-sm font-medium">
                {localize('com_ui_client_id')}{' '}
                {!isEditMode && (
                  <>
                    <span aria-hidden="true" className="text-text-secondary">
                      *
                    </span>
                    <span className="sr-only">{localize('com_ui_field_required')}</span>
                  </>
                )}
              </Label>
              <SecretInput
                id="oauth_client_id"
                autoComplete="new-password"
                data-lpignore="true"
                data-1p-ignore="true"
                controlsOnHover
                placeholder={isEditMode ? localize('com_ui_leave_blank_to_keep') : ''}
                aria-invalid={errors.auth?.oauth_client_id ? 'true' : 'false'}
                aria-describedby={
                  errors.auth?.oauth_client_id ? 'oauth-client-id-error' : undefined
                }
                {...register('auth.oauth_client_id', {
                  required: !isEditMode && authType === AuthTypeEnum.OAuth,
                })}
                className={cn(errors.auth?.oauth_client_id && 'border-border-destructive')}
              />
              {errors.auth?.oauth_client_id && (
                <p
                  id="oauth-client-id-error"
                  role="alert"
                  className="text-xs text-text-destructive"
                >
                  {localize('com_ui_field_required')}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="oauth_client_secret" className="text-sm font-medium">
                {localize('com_ui_client_secret')}
              </Label>
              <SecretInput
                id="oauth_client_secret"
                placeholder={isEditMode ? localize('com_ui_leave_blank_to_keep') : ''}
                controlsOnHover
                {...register('auth.oauth_client_secret')}
              />
            </div>
          </div>

          {/* Auth URL & Token URL in a grid */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="oauth_authorization_url" className="text-sm font-medium">
                {localize('com_ui_auth_url')}
              </Label>
              <Input
                id="oauth_authorization_url"
                placeholder="https://..."
                {...register('auth.oauth_authorization_url')}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="oauth_token_url" className="text-sm font-medium">
                {localize('com_ui_token_url')}
              </Label>
              <Input
                id="oauth_token_url"
                placeholder="https://..."
                {...register('auth.oauth_token_url')}
              />
            </div>
          </div>

          {/* Scope */}
          <div className="space-y-1.5">
            <Label htmlFor="oauth_scope" className="text-sm font-medium">
              {localize('com_ui_scope')}
            </Label>
            <Input id="oauth_scope" placeholder="read write" {...register('auth.oauth_scope')} />
          </div>

          {/* Token exchange method */}
          <fieldset className="space-y-1.5">
            <legend>
              <Label id="oauth-token-exchange-method-label" className="text-sm font-medium">
                {localize('com_ui_token_exchange_method')}
              </Label>
            </legend>
            <Radio
              options={[
                { value: AUTO_TOKEN_EXCHANGE_METHOD, label: localize('com_ui_auto') },
                {
                  value: TokenExchangeMethodEnum.DefaultPost,
                  label: localize('com_ui_default_post_request'),
                },
                {
                  value: TokenExchangeMethodEnum.BasicAuthHeader,
                  label: localize('com_ui_basic_auth_header'),
                },
              ]}
              value={tokenExchangeMethod ?? AUTO_TOKEN_EXCHANGE_METHOD}
              onChange={(value) =>
                setValue(
                  'auth.oauth_token_exchange_method',
                  value === AUTO_TOKEN_EXCHANGE_METHOD
                    ? undefined
                    : (value as TokenExchangeMethodEnum),
                  { shouldDirty: true },
                )
              }
              fullWidth
              aria-labelledby="oauth-token-exchange-method-label"
            />
          </fieldset>

          {/* Redirect URI */}
          {isEditMode && redirectUri && (
            <div className="space-y-1.5">
              <Label htmlFor="auth-redirect-uri" className="text-sm font-medium">
                {localize('com_ui_redirect_uri')}
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  id="auth-redirect-uri"
                  type="text"
                  readOnly
                  value={redirectUri}
                  className="flex-1 text-xs text-text-secondary"
                />
                <button
                  type="button"
                  onClick={() => {
                    if (isCopying) return;
                    if (!copyLink(setIsCopying)) return;
                    showToast({ message: localize('com_ui_copied_to_clipboard') });
                  }}
                  className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border-light text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
                  aria-label={localize('com_ui_copy_link')}
                >
                  <MorphIcon icon={isCopying ? CopyCheck : Copy} className="size-4" />
                </button>
              </div>
            </div>
          )}
        </div>
      </Collapse>

      {/* OBO Fields */}
      <Collapse open={authType === AuthTypeEnum.OBO} className="pt-3">
        <div className="space-y-3 rounded-lg border border-border-light p-3">
          <div className="space-y-1.5">
            <Label htmlFor="obo_scopes" className="text-sm font-medium">
              {localize('com_ui_obo_scopes')}{' '}
              <span aria-hidden="true" className="text-text-secondary">
                *
              </span>
              <span className="sr-only">{localize('com_ui_field_required')}</span>
            </Label>
            <Input
              id="obo_scopes"
              placeholder="api://<client-id>/Mcp.Tools.ReadWrite"
              disabled={!canConfigureObo}
              aria-invalid={errors.auth?.obo_scopes ? 'true' : 'false'}
              aria-describedby={
                canConfigureObo ? 'obo-scopes-description' : 'obo-scopes-readonly-description'
              }
              {...register('auth.obo_scopes', {
                required: canConfigureObo && authType === AuthTypeEnum.OBO,
              })}
              className={cn(errors.auth?.obo_scopes && 'border-border-destructive')}
            />
            {errors.auth?.obo_scopes && (
              <p role="alert" className="text-xs text-text-destructive">
                {localize('com_ui_field_required')}
              </p>
            )}
            {canConfigureObo ? (
              <p id="obo-scopes-description" className="text-xs text-text-secondary">
                {localize('com_ui_obo_scopes_description')}
              </p>
            ) : (
              <p id="obo-scopes-readonly-description" className="text-xs text-text-secondary">
                {localize('com_ui_obo_readonly_no_permission')}
              </p>
            )}
          </div>
        </div>
      </Collapse>
    </div>
  );
}
