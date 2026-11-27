import { useEffect, useMemo, useCallback, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useToastContext } from '@librechat/client';
import type { MCPServerCreateParams, TokenExchangeMethodEnum } from 'librechat-data-provider';
import type { MCPServerDefinition } from '~/hooks';
import {
  useCreateMCPServerMutation,
  useUpdateMCPServerMutation,
  useDeleteMCPServerMutation,
} from '~/data-provider/MCP';
import { extractServerNameFromUrl, isValidUrl, normalizeUrl } from '../utils/urlUtils';
import { getMCPServerErrorMessage } from '../utils/error';
import { getOAuthConfig } from '../utils/oauth';
import { useLocalize } from '~/hooks';

// Auth type enum
export enum AuthTypeEnum {
  None = 'none',
  ServiceHttp = 'service_http',
  OAuth = 'oauth',
  OBO = 'obo',
}

// Authorization type enum
export enum AuthorizationTypeEnum {
  Basic = 'basic',
  Bearer = 'bearer',
  Custom = 'custom',
}

// Auth configuration interface
export interface AuthConfig {
  auth_type: AuthTypeEnum;
  api_key?: string;
  api_key_source?: 'admin' | 'user';
  api_key_authorization_type?: AuthorizationTypeEnum;
  api_key_custom_header?: string;
  oauth_client_id?: string;
  oauth_client_secret?: string;
  oauth_authorization_url?: string;
  oauth_token_url?: string;
  oauth_scope?: string;
  oauth_token_exchange_method?: TokenExchangeMethodEnum;
  obo_scopes?: string;
  server_id?: string;
}

// Form data interface
export interface MCPServerFormData {
  title: string;
  description?: string;
  icon?: string;
  url: string;
  type: 'streamable-http' | 'sse';
  auth: AuthConfig;
  trust: boolean;
}

interface UseMCPServerFormProps {
  server?: MCPServerDefinition | null;
  onSuccess?: (serverName: string, isOAuth: boolean) => void;
  onClose?: () => void;
}

export function useMCPServerForm({ server, onSuccess, onClose }: UseMCPServerFormProps) {
  const localize = useLocalize();
  const { showToast } = useToastContext();

  // Mutations
  const createMutation = useCreateMCPServerMutation();
  const updateMutation = useUpdateMCPServerMutation();
  const deleteMutation = useDeleteMCPServerMutation();

  // State
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  // Check if editing existing server
  const isEditMode = !!server;

  // Default form values
  const defaultValues = useMemo<MCPServerFormData>(() => {
    if (server) {
      let authType = AuthTypeEnum.None;
      if ('obo' in server.config && server.config.obo) {
        authType = AuthTypeEnum.OBO;
      } else if (server.config.oauth) {
        authType = AuthTypeEnum.OAuth;
      } else if ('apiKey' in server.config && server.config.apiKey) {
        authType = AuthTypeEnum.ServiceHttp;
      }

      const apiKeyConfig = 'apiKey' in server.config ? server.config.apiKey : undefined;

      return {
        title: server.config.title || '',
        description: server.config.description || '',
        url: 'url' in server.config ? server.config.url : '',
        type: (server.config.type as 'streamable-http' | 'sse') || 'streamable-http',
        icon: server.config.iconPath || '',
        auth: {
          auth_type: authType,
          api_key: '', // Never pre-fill secrets
          api_key_source: (apiKeyConfig?.source as 'admin' | 'user') || 'admin',
          api_key_authorization_type:
            (apiKeyConfig?.authorization_type as AuthorizationTypeEnum) ||
            AuthorizationTypeEnum.Bearer,
          api_key_custom_header: apiKeyConfig?.custom_header || '',
          oauth_client_id: server.config.oauth?.client_id || '',
          oauth_client_secret: '', // Never pre-fill secrets
          oauth_authorization_url: server.config.oauth?.authorization_url || '',
          oauth_token_url: server.config.oauth?.token_url || '',
          oauth_scope: server.config.oauth?.scope || '',
          oauth_token_exchange_method: server.config.oauth?.token_exchange_method,
          obo_scopes: 'obo' in server.config && server.config.obo ? server.config.obo.scopes : '',
          server_id: server.serverName,
        },
        trust: true, // Pre-checked for existing servers
      };
    }

    return {
      title: '',
      description: '',
      url: '',
      type: 'streamable-http',
      icon: '',
      auth: {
        auth_type: AuthTypeEnum.None,
        api_key: '',
        api_key_source: 'admin',
        api_key_authorization_type: AuthorizationTypeEnum.Bearer,
        api_key_custom_header: '',
        oauth_client_id: '',
        oauth_client_secret: '',
        oauth_authorization_url: '',
        oauth_token_url: '',
        oauth_scope: '',
        oauth_token_exchange_method: undefined,
        obo_scopes: '',
      },
      trust: false,
    };
  }, [server]);

  // Form instance
  const methods = useForm<MCPServerFormData>({
    defaultValues,
    mode: 'onChange',
  });

  const { reset, watch, setValue, getValues } = methods;

  // Watch URL for auto-fill
  const watchedUrl = watch('url');

  // Auto-fill title from URL when title is empty
  const handleUrlChange = useCallback(
    (url: string) => {
      const currentTitle = getValues('title');
      if (!currentTitle && url) {
        const normalizedUrl = normalizeUrl(url);
        if (isValidUrl(normalizedUrl)) {
          const suggestedName = extractServerNameFromUrl(normalizedUrl);
          if (suggestedName) {
            setValue('title', suggestedName, { shouldValidate: true });
          }
        }
      }
    },
    [getValues, setValue],
  );

  // Watch for URL changes
  useEffect(() => {
    handleUrlChange(watchedUrl);
  }, [watchedUrl, handleUrlChange]);

  // Reset form when dialog opens
  const resetForm = useCallback(() => {
    reset(defaultValues);
  }, [reset, defaultValues]);

  // Handle form submission
  const onSubmit = methods.handleSubmit(async (formData: MCPServerFormData) => {
    setIsSubmitting(true);
    try {
      const config: Record<string, unknown> = {
        type: formData.type,
        url: formData.url,
        title: formData.title,
        ...(formData.description && { description: formData.description }),
        ...(formData.icon && { iconPath: formData.icon }),
      };

      // Add OAuth configuration
      const oauthConfig = getOAuthConfig(formData.auth);
      if (oauthConfig) {
        config.oauth = oauthConfig;
      }

      // Add API Key configuration
      if (formData.auth.auth_type === AuthTypeEnum.ServiceHttp) {
        const source = formData.auth.api_key_source || 'admin';
        const authorizationType = formData.auth.api_key_authorization_type || 'bearer';

        config.apiKey = {
          source,
          authorization_type: authorizationType,
          ...(source === 'admin' && formData.auth.api_key && { key: formData.auth.api_key }),
          ...(authorizationType === 'custom' &&
            formData.auth.api_key_custom_header && {
              custom_header: formData.auth.api_key_custom_header,
            }),
        };
      }

      if (formData.auth.auth_type === AuthTypeEnum.OBO && formData.auth.obo_scopes) {
        config.obo = { scopes: formData.auth.obo_scopes };
      }

      const params: MCPServerCreateParams = { config };

      const result = server
        ? await updateMutation.mutateAsync({ serverName: server.serverName, data: params })
        : await createMutation.mutateAsync(params);

      showToast({
        message: server
          ? localize('com_ui_mcp_server_updated')
          : localize('com_ui_mcp_server_created'),
        status: 'success',
      });

      const isOAuth = formData.auth.auth_type === AuthTypeEnum.OAuth;
      onSuccess?.(result.serverName, isOAuth && !server);
    } catch (error: unknown) {
      let errorMessage = localize('com_ui_error');

      if (error && typeof error === 'object' && 'response' in error) {
        const axiosError = error as { response?: { data?: { error?: string } } };
        const errorCode = axiosError.response?.data?.error;
        if (errorCode) {
          errorMessage = getMCPServerErrorMessage(errorCode, localize);
        }
      } else if (error instanceof Error) {
        errorMessage = error.message;
      }

      showToast({
        message: errorMessage,
        status: 'error',
      });
    } finally {
      setIsSubmitting(false);
    }
  });

  // Handle delete
  const handleDelete = useCallback(async () => {
    if (!server) {
      return;
    }

    setIsDeleting(true);
    try {
      await deleteMutation.mutateAsync(server.serverName);

      showToast({
        message: localize('com_ui_mcp_server_deleted'),
        status: 'success',
      });

      onClose?.();
    } catch (error: unknown) {
      let errorMessage = localize('com_ui_error');

      if (error && typeof error === 'object' && 'response' in error) {
        const axiosError = error as { response?: { data?: { error?: string } } };
        if (axiosError.response?.data?.error) {
          errorMessage = axiosError.response.data.error;
        }
      } else if (error instanceof Error) {
        errorMessage = error.message;
      }

      showToast({
        message: errorMessage,
        status: 'error',
      });
    } finally {
      setIsDeleting(false);
    }
  }, [server, deleteMutation, showToast, localize, onClose]);

  return {
    methods,
    isEditMode,
    isSubmitting,
    isDeleting,
    onSubmit,
    handleDelete,
    resetForm,
    server,
  };
}
