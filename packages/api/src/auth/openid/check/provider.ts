interface CheckConfiguration {
  serverMetadata(): { issuer: string; [key: string]: unknown };
  clientMetadata(): { client_id: string; [key: string]: unknown };
  timeout?: number;
}
interface OpenIDCheckClient<Configuration extends CheckConfiguration> {
  Configuration: new (
    server: ReturnType<CheckConfiguration['serverMetadata']>,
    clientId: string,
    metadata: ReturnType<CheckConfiguration['clientMetadata']>,
  ) => Configuration;
  customFetch: symbol;
  enableNonRepudiationChecks(config: Configuration): void;
  allowInsecureRequests(config: Configuration): void;
  calculatePKCECodeChallenge(verifier: string): Promise<string>;
  buildAuthorizationUrl(config: Configuration, parameters: Record<string, string>): URL;
  authorizationCodeGrant(
    config: Configuration,
    url: URL,
    checks: {
      pkceCodeVerifier: string;
      expectedState: string;
      expectedNonce: string;
      idTokenExpected: boolean;
    },
  ): Promise<{ claims(): { iss: string; sub: string } | undefined }>;
  AuthorizationResponseError: new (...args: never[]) => Error & { error: string };
}

export type CheckIdentity = { iss: string; sub: string };
export type ProviderCheckResult =
  | { status: 'verified'; identity: CheckIdentity }
  | { status: 'login_required' | 'interaction_required' };
export type CheckProof = { state: string; verifier: string; nonce: string };

/** The probe never publishes its tokens or asks for offline/API access. */
export function createOpenIDCheckProvider<Configuration extends CheckConfiguration>(
  client: OpenIDCheckClient<Configuration>,
  getConfig: () => Configuration,
  redirectUri: string,
): {
  authorize(proof: CheckProof): Promise<string>;
  verify(url: URL, proof: CheckProof): Promise<ProviderCheckResult>;
} {
  let cachedSource: Configuration | undefined;
  let cachedConfig: Configuration | undefined;
  const checkConfig = (): Configuration => {
    const source = getConfig();
    if (cachedSource === source && cachedConfig) return cachedConfig;
    const metadata = source.clientMetadata();
    const config = new client.Configuration(source.serverMetadata(), metadata.client_id, metadata);
    const fetch = Reflect.get(source, client.customFetch);
    if (fetch) Reflect.set(config, client.customFetch, fetch);
    config.timeout = source.timeout;
    // Local test issuers already require an explicit insecure discovery configuration.
    if (new URL(source.serverMetadata().issuer).protocol === 'http:')
      client.allowInsecureRequests(config);
    client.enableNonRepudiationChecks(config);
    cachedSource = source;
    cachedConfig = config;
    return config;
  };
  return {
    async authorize(proof: CheckProof): Promise<string> {
      const challenge = await client.calculatePKCECodeChallenge(proof.verifier);
      return client.buildAuthorizationUrl(checkConfig(), {
        redirect_uri: redirectUri,
        scope: 'openid',
        response_type: 'code',
        prompt: 'none',
        state: proof.state,
        nonce: proof.nonce,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }).href;
    },
    async verify(url: URL, proof: CheckProof): Promise<ProviderCheckResult> {
      try {
        const tokens = await client.authorizationCodeGrant(checkConfig(), url, {
          pkceCodeVerifier: proof.verifier,
          expectedState: proof.state,
          expectedNonce: proof.nonce,
          idTokenExpected: true,
        });
        const claims = tokens.claims();
        if (!claims?.iss || !claims.sub) {
          throw new Error('OpenID check returned no identity');
        }
        return { status: 'verified', identity: { iss: claims.iss, sub: claims.sub } };
      } catch (error) {
        if (!(error instanceof client.AuthorizationResponseError)) {
          throw error;
        }
        if (error.error === 'login_required') {
          return { status: 'login_required' };
        }
        if (
          ['interaction_required', 'consent_required', 'account_selection_required'].includes(
            error.error,
          )
        ) {
          return { status: 'interaction_required' };
        }
        throw error;
      }
    },
  };
}
