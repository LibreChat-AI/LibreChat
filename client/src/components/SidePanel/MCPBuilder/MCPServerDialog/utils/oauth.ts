import type { MCPOptions, TokenExchangeMethodEnum } from 'librechat-data-provider';

interface OAuthFormConfig {
  auth_type: string;
  oauth_client_id?: string;
  oauth_client_secret?: string;
  oauth_authorization_url?: string;
  oauth_token_url?: string;
  oauth_scope?: string;
  oauth_token_exchange_method?: TokenExchangeMethodEnum;
}

export function getOAuthConfig(
  auth: OAuthFormConfig,
): NonNullable<MCPOptions['oauth']> | undefined {
  if (auth.auth_type !== 'oauth') {
    return undefined;
  }

  const oauth: NonNullable<MCPOptions['oauth']> = {
    ...(auth.oauth_client_id && { client_id: auth.oauth_client_id }),
    ...(auth.oauth_client_secret && { client_secret: auth.oauth_client_secret }),
    ...(auth.oauth_authorization_url && { authorization_url: auth.oauth_authorization_url }),
    ...(auth.oauth_token_url && { token_url: auth.oauth_token_url }),
    ...(auth.oauth_scope && { scope: auth.oauth_scope }),
    ...(auth.oauth_token_exchange_method && {
      token_exchange_method: auth.oauth_token_exchange_method,
    }),
  };

  return Object.keys(oauth).length > 0 ? oauth : undefined;
}
