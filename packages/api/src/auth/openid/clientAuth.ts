export type OpenIdTokenEndpointAuthMethod = 'client_secret_basic' | 'client_secret_post' | 'none';

export type OpenIdClientAuthErrorCode =
  | 'OPENID_INVALID_TOKEN_ENDPOINT_AUTH_METHOD'
  | 'OPENID_CLIENT_SECRET_REQUIRED';

/** The `openid-client` client authentication factories, supplied by the caller. */
export interface OpenIdClientAuthFactories<TAuth> {
  ClientSecretBasic: (clientSecret: string) => TAuth;
  ClientSecretPost: (clientSecret: string) => TAuth;
  None: () => TAuth;
}

export interface OpenIdClientAuth<TAuth> {
  /** Value for the client metadata `token_endpoint_auth_method`, when one is set. */
  tokenEndpointAuthMethod?: OpenIdTokenEndpointAuthMethod;
  /**
   * The `clientAuthentication` argument for `discovery`. Left undefined when no method is
   * configured, so `openid-client` keeps its default (`ClientSecretPost` with a secret).
   */
  clientAuthentication?: TAuth;
}

export type OpenIdClientAuthResult<TAuth> =
  | { ok: true; value: OpenIdClientAuth<TAuth> }
  | { ok: false; error: { code: OpenIdClientAuthErrorCode; message: string } };

const TOKEN_ENDPOINT_AUTH_METHODS: readonly OpenIdTokenEndpointAuthMethod[] = [
  'client_secret_basic',
  'client_secret_post',
  'none',
];

function isTokenEndpointAuthMethod(value: string): value is OpenIdTokenEndpointAuthMethod {
  return (TOKEN_ENDPOINT_AUTH_METHODS as readonly string[]).includes(value);
}

/** Behavior before `OPENID_TOKEN_ENDPOINT_AUTH_METHOD` existed; kept as the default. */
function resolveDefaultClientAuth<TAuth>(options: {
  clientSecret?: string;
  usePKCE: boolean;
  generateNonce: boolean;
}): OpenIdClientAuth<TAuth> {
  if (options.clientSecret) {
    return options.generateNonce ? { tokenEndpointAuthMethod: 'client_secret_post' } : {};
  }
  return options.usePKCE ? { tokenEndpointAuthMethod: 'none' } : {};
}

/**
 * Chooses how LibreChat authenticates to the OpenID provider's token endpoint.
 *
 * `openid-client` ignores `metadata.token_endpoint_auth_method` and always sends the secret in
 * the request body unless `discovery` receives a `clientAuthentication`. An explicit `method`
 * therefore builds that argument; leaving it unset reproduces the previous behavior.
 *
 * `client_secret_basic` follows RFC 6749 §2.3.1: the client id and secret are form-urlencoded
 * before Base64 encoding.
 */
export function resolveOpenIdClientAuth<TAuth>(options: {
  method?: string;
  clientSecret?: string;
  usePKCE: boolean;
  generateNonce: boolean;
  factories: OpenIdClientAuthFactories<TAuth>;
}): OpenIdClientAuthResult<TAuth> {
  const method = options.method?.trim().toLowerCase();
  if (!method) {
    return { ok: true, value: resolveDefaultClientAuth<TAuth>(options) };
  }

  if (!isTokenEndpointAuthMethod(method)) {
    return {
      ok: false,
      error: {
        code: 'OPENID_INVALID_TOKEN_ENDPOINT_AUTH_METHOD',
        message: `OPENID_TOKEN_ENDPOINT_AUTH_METHOD must be one of: ${TOKEN_ENDPOINT_AUTH_METHODS.join(', ')}`,
      },
    };
  }

  if (method === 'none') {
    return {
      ok: true,
      value: { tokenEndpointAuthMethod: method, clientAuthentication: options.factories.None() },
    };
  }

  if (!options.clientSecret) {
    return {
      ok: false,
      error: {
        code: 'OPENID_CLIENT_SECRET_REQUIRED',
        message: `OPENID_TOKEN_ENDPOINT_AUTH_METHOD=${method} requires OPENID_CLIENT_SECRET`,
      },
    };
  }

  const factory =
    method === 'client_secret_basic'
      ? options.factories.ClientSecretBasic
      : options.factories.ClientSecretPost;

  return {
    ok: true,
    value: { tokenEndpointAuthMethod: method, clientAuthentication: factory(options.clientSecret) },
  };
}
